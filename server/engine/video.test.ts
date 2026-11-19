import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { animatic, probe, sample } from '../media/ffmpeg.ts'
import { lipSyncUsd, priceList } from '../media/prices.ts'
import { mediaTools } from './tools.ts'
import type { ToolFamily } from './types.ts'

let installed = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { installed = false }

test('el animatic dura la suma de los planos, a 16:9 y sin audio', { skip: !installed && 'ffmpeg no está instalado' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pana-animatic-'))
  const f = (name: string) => join(dir, name)
  try {
    await Promise.all([sample('image', f('a.jpg')), sample('image', f('b.png'))])
    // b.png hace de rótulo transparente: lo importante es que la cadena con sobreimpresión funcione.
    await animatic([{ file: f('a.jpg'), seconds: 1.5, overlay: f('b.png') }, { file: f('b.png'), seconds: 2 }, { file: f('a.jpg'), seconds: 0.5 }], f('animatic.mp4'))
    const m = await probe(f('animatic.mp4'))
    assert.ok(Math.abs(m.durationSeconds! - 4) < 0.1, `el animatic dura ${m.durationSeconds}`)
    assert.deepEqual([m.width, m.height, m.fps, m.hasAudio], [1920, 1080, 30, false])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('las tarifas anuncian la duración libre de Kling 3.0 y la sincronía de labios cobra por tramos de 5 s', () => {
  assert.match(priceList(undefined, 'kling-3-pro'), /de 3 a 10 segundos/)
  assert.match(priceList(undefined, 'kling-2.6-pro'), /5 o 10 segundos/)
  assert.match(priceList(), /lip_sync/)
  assert.equal(lipSyncUsd(3), 0.07)
  assert.equal(lipSyncUsd(7), 0.14)
})

/** Herramientas con archivos falsos y fal.ai simulado: se ve qué llegaría al proveedor sin gastar nada. */
async function withFakeFal(videoModel: string, run: (tool: (name: string, input: object) => Promise<any>, sent: any[]) => Promise<void>) {
  const sent: any[] = []
  const realFetch = globalThis.fetch
  process.env.FAL_KEY ||= 'prueba'
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    if (init?.method === 'POST') { sent.push(JSON.parse(init.body)); return Response.json({ status_url: 'https://fake/status', response_url: 'https://fake/result' }) }
    if (u === 'https://fake/status') return Response.json({ status: 'COMPLETED' })
    if (u === 'https://fake/result') return Response.json({ video: { url: 'https://fake/v.mp4' } })
    return new Response(new Uint8Array([1, 2, 3]))
  }) as typeof fetch
  let spent = 0
  const families: ToolFamily[] = ['video']
  const tools = mediaTools({
    projectId: 'p1', videoModel, dir: 'p1/production/generation-operators/v1', families,
    files: { url: async (p: string) => `https://files/${p}`, writeBytes: async () => {}, readBytes: async () => new Uint8Array() } as any,
    brand: null, brandName: 'Marca', budgetLeft: () => 100, spend: async (usd) => { spent += usd }, record: async () => {}, assets: async () => [], wrote: () => {}, abort: () => {},
  })
  try {
    await run(async (name, input) => (tools.find((t) => t.name === name) as any).run(input), sent)
  } finally {
    globalThis.fetch = realFetch
  }
  return spent
}

const base = { prompt: 'Camera pushes in slowly on @Element1', image_file: 'storyboard/S01.jpg', quality: 'final', filename: 'S01-t1.mp4', elements: [{ frontal_file: 'character-ana.jpg', reference_files: ['referencias/ana2.jpg'] }] }

test('con Kling 3.0 el plano pide su duración y los personajes viajan como elements', async () => {
  const spent = await withFakeFal('kling-3-pro', async (tool, sent) => {
    const out = await tool('generate_video', { ...base, duration_seconds: 3 })
    assert.doesNotMatch(out, /Aviso|Error/)
    assert.equal(sent[0].duration, '3')
    assert.deepEqual(sent[0].elements, [{ frontal_image_url: 'https://files/p1/character-ana.jpg', reference_image_urls: ['https://files/p1/referencias/ana2.jpg'] }])
    assert.match(await tool('generate_video', { ...base, filename: 'S01-t2.mp4', duration_seconds: 11 }), /Error.*de 3 a 10/)
  })
  assert.ok(Math.abs(spent - 3 * 0.112) < 1e-9)
})

test('con Kling 2.6 los elements se ignoran con aviso y la duración sigue en 5 o 10', async () => {
  await withFakeFal('kling-2.6-pro', async (tool, sent) => {
    const out = await tool('generate_video', { ...base, duration_seconds: 5 })
    assert.match(out, /Aviso.*no admite `elements`/)
    assert.equal(sent[0].elements, undefined)
    assert.match(await tool('generate_video', { ...base, filename: 'S01-t2.mp4', duration_seconds: 3 }), /Error.*5 o 10/)
  })
})
