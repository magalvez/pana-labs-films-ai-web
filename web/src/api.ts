let token: string | null = null
export const setToken = (t: string | null) => { token = t }
// La sesión caducó o fue revocada: la app vuelve a la pantalla de entrada en vez de reintentar para siempre.
let onExpired = () => {}
export const setOnExpired = (fn: () => void) => { onExpired = fn }
const auth = () => (token ? { authorization: `Bearer ${token}` } : undefined)

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...auth(), ...(body ? { 'content-type': 'application/json' } : undefined) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (res.status === 401 && token) onExpired()
  if (!res.ok) throw new Error(json.error ?? 'No se pudo completar la acción')
  return json
}

/** Abre un entregable en otra pestaña. Va por fetch porque un enlace normal no puede llevar la sesión. */
export async function openFile(path: string) {
  const tab = window.open('', '_blank')
  const res = await fetch(`/api${path}`, { headers: auth() })
  if (!res.ok) { tab?.close(); throw new Error('No se pudo abrir el archivo') }
  // Siempre como texto: un entregable nunca debe ejecutarse como página en el origen de la app.
  const url = URL.createObjectURL(new Blob([await res.blob()], { type: 'text/plain; charset=utf-8' }))
  if (tab) tab.location.href = url
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Descarga un archivo con la sesión y devuelve una dirección local para mostrarlo en una imagen, un video o un audio. */
export async function blobUrl(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { headers: auth() })
  if (!res.ok) throw new Error('No se pudo abrir el archivo')
  return URL.createObjectURL(await res.blob())
}

export async function upload<T = unknown>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: auth(), body: form })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'No se pudo subir el archivo')
  return json
}
