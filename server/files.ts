import type { SupabaseClient } from '@supabase/supabase-js'
import type { Files } from './engine/types.ts'

const safe = (path: string) => {
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Ruta no permitida: ${path}`)
  return path
}

export function supabaseFiles(supabase: SupabaseClient, bucket = 'workspace'): Files {
  const store = supabase.storage.from(bucket)
  return {
    async read(path) {
      const { data } = await store.download(safe(path))
      return data ? await data.text() : null
    },
    async write(path, content) {
      const { error } = await store.upload(safe(path), content, { upsert: true, contentType: 'text/plain; charset=utf-8' })
      if (error) throw new Error(`No se pudo guardar ${path} en Supabase Storage: ${error.message}`)
    },
    async removeDir(prefix) {
      const { data } = await store.list(safe(prefix))
      if (data?.length) await store.remove(data.map((f) => `${prefix}/${f.name}`))
    },
  }
}
