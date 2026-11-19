import assert from 'node:assert/strict'
import { test } from 'node:test'
import { supabaseFiles } from './files.ts'

// Un Storage que, como el real, sigue devolviendo la versión anterior de un archivo recién sobrescrito.
function staleStorage() {
  const live = new Map<string, Uint8Array>(), cached = new Map<string, Uint8Array>()
  const store = {
    download: async (path: string) => {
      const bytes = cached.get(path) ?? live.get(path)
      if (!bytes) return { data: null, error: { status: 404 } }
      cached.set(path, bytes)
      return { data: new Blob([bytes as Uint8Array<ArrayBuffer>]), error: null }
    },
    upload: async (path: string, bytes: Uint8Array) => (live.set(path, bytes), { error: null }),
    list: async (dir: string) => ({ data: [...live.keys()].filter((k) => k.startsWith(dir + '/')).map((k) => ({ id: k, name: k.slice(dir.length + 1) })), error: null }),
    remove: async (paths: string[]) => (paths.forEach((p) => live.delete(p)), { error: null }),
    copy: async (from: string, to: string) => (live.set(to, live.get(from)!), { error: null }),
  }
  return { storage: { from: () => store } } as any
}

test('lo recién escrito o borrado se lee al momento aunque Storage devuelva la versión anterior', async () => {
  const files = supabaseFiles(staleStorage())
  await files.write('p/estado.json', '[1]')
  assert.equal(await files.read('p/estado.json'), '[1]')
  await files.write('p/estado.json', '[1,2]')
  assert.equal(await files.read('p/estado.json'), '[1,2]', 'no vuelve la versión anterior')
  await files.copy('p/estado.json', 'p/copia.json')
  assert.equal(await files.read('p/copia.json'), '[1,2]')
  await files.removeDir('p')
  assert.equal(await files.read('p/estado.json'), null, 'un archivo borrado no reaparece')
})
