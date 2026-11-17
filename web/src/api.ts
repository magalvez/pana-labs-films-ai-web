let token: string | null = null
export const setToken = (t: string | null) => { token = t }
const auth = () => (token ? { authorization: `Bearer ${token}` } : undefined)

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...auth(), ...(body ? { 'content-type': 'application/json' } : undefined) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'No se pudo completar la acción')
  return json
}

/** Abre un entregable en otra pestaña. Va por fetch porque un enlace normal no puede llevar la sesión. */
export async function openFile(path: string) {
  const tab = window.open('', '_blank')
  const res = await fetch(`/api${path}`, { headers: auth() })
  if (!res.ok) { tab?.close(); throw new Error('No se pudo abrir el archivo') }
  const url = URL.createObjectURL(await res.blob())
  if (tab) tab.location.href = url
}
