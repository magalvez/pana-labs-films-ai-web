import type { SupabaseClient } from '@supabase/supabase-js'
import type { Files } from './engine/types.ts'

const safe = (path: string) => {
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Ruta no permitida: ${path}`)
  return path
}

export function supabaseFiles(supabase: SupabaseClient, bucket = 'workspace'): Files {
  const store = supabase.storage.from(bucket)
  // Storage puede devolver durante cerca de un minuto la versión anterior de un archivo recién sobrescrito (medido: ~40 s).
  // El estado que se lee, se cambia y se vuelve a guardar (comentarios, tableros, notas) perdería cambios, así que lo
  // escrito hace poco se responde desde aquí. `null` recuerda un archivo borrado.
  // ponytail: vale con un solo proceso; con varios servidores este estado tendría que ir a la base de datos.
  const FRESH_MS = 120_000, FRESH_MAX = 512 * 1024
  const recent = new Map<string, { bytes: Uint8Array | null; until: number }>()
  const remember = (path: string, bytes: Uint8Array | null) => {
    if (bytes && bytes.length > FRESH_MAX) return void recent.delete(path)
    if (recent.size > 2000) for (const [key, hit] of recent) if (hit.until < Date.now()) recent.delete(key)
    recent.set(path, { bytes, until: Date.now() + FRESH_MS })
  }
  const files: Files = {
    async read(path) {
      const bytes = await files.readBytes(path)
      return bytes ? new TextDecoder().decode(bytes) : null
    },
    write: (path, content) => files.writeBytes(path, new TextEncoder().encode(content), 'text/plain; charset=utf-8'),
    async readBytes(path) {
      const hit = recent.get(path)
      if (hit && hit.until > Date.now()) return hit.bytes
      const { data, error } = await store.download(safe(path))
      if (data) return new Uint8Array(await data.arrayBuffer())
      // "No existe" es una respuesta normal. Un fallo de red o del servicio no: tratarlo como archivo
      // ausente haría creer al motor que el agente no entregó.
      // Storage responde HTTP 400 a casi todo; lo que distingue al "no existe" es el código 404 del cuerpo.
      const e = error as { status?: number; statusCode?: string; message?: string } | null
      if (e?.status === 404 || e?.statusCode === '404' || /not found/i.test(e?.message ?? '')) return null
      throw new Error(`No se pudo leer ${path} de Supabase Storage: ${error?.message || 'sin respuesta'}`)
    },
    async writeBytes(path, bytes, contentType) {
      const { error } = await store.upload(safe(path), bytes, { upsert: true, contentType, cacheControl: '0' })
      if (error) throw new Error(`No se pudo guardar ${path} en Supabase Storage: ${error.message}`)
      remember(path, bytes)
    },
    async list(dir) {
      const { data, error } = await store.list(safe(dir), { limit: 1000 })
      if (error) throw new Error(`No se pudo listar ${dir} en Supabase Storage: ${error.message}`)
      // Las subcarpetas llegan sin id; solo interesan los archivos.
      return data.filter((f) => f.id && f.name !== '.emptyFolderPlaceholder').map((f) => f.name)
    },
    async copy(from, to) {
      await store.remove([safe(to)])
      const { error } = await store.copy(safe(from), safe(to))
      if (error) throw new Error(`No se pudo copiar ${from} en Supabase Storage: ${error.message}`)
      const src = recent.get(from)
      if (src && src.until > Date.now()) remember(to, src.bytes)
      else recent.delete(to)
    },
    async url(path) {
      const { data, error } = await store.createSignedUrl(safe(path), 3600)
      if (error) throw new Error(`No se pudo compartir ${path} con el proveedor: ${error.message}`)
      return data.signedUrl
    },
    async removeDir(prefix) {
      const names = await files.list(prefix)
      if (!names.length) return
      const { error } = await store.remove(names.map((name) => `${prefix}/${name}`))
      if (error) throw new Error(`No se pudo vaciar ${prefix} en Supabase Storage: ${error.message}`)
      for (const name of names) remember(`${prefix}/${name}`, null)
    },
  }
  return files
}
