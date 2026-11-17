import type { SupabaseClient } from '@supabase/supabase-js'
import type { Files } from './engine/types.ts'

const safe = (path: string) => {
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Ruta no permitida: ${path}`)
  return path
}

export function supabaseFiles(supabase: SupabaseClient, bucket = 'workspace'): Files {
  const store = supabase.storage.from(bucket)
  const files: Files = {
    async read(path) {
      const bytes = await files.readBytes(path)
      return bytes ? new TextDecoder().decode(bytes) : null
    },
    write: (path, content) => files.writeBytes(path, new TextEncoder().encode(content), 'text/plain; charset=utf-8'),
    async readBytes(path) {
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
      const { error } = await store.upload(safe(path), bytes, { upsert: true, contentType })
      if (error) throw new Error(`No se pudo guardar ${path} en Supabase Storage: ${error.message}`)
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
    },
  }
  return files
}
