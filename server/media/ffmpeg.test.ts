import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cut, grade, master, mix, preview, probe, reframe, sample } from './ffmpeg.ts'

let installed = true
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }) } catch { installed = false }

// La cadena completa de postproducción sobre archivos sintéticos: corte, color, mezcla, máster y versión vertical.
test('el montaje con ffmpeg produce un máster con la duración, el tamaño y la sonoridad pedidos', { skip: !installed && 'ffmpeg no está instalado' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pana-ffmpeg-'))
  const f = (name: string) => join(dir, name)
  try {
    await Promise.all([sample('video', f('a.mp4')), sample('video', f('b.mp4')), sample('audio', f('voz.mp3')), sample('image', f('super.png'))])
    assert.deepEqual({ ...(await probe(f('super.png'))), lufs: null }, { durationSeconds: null, width: 640, height: 360, fps: null, hasAudio: false, lufs: null })

    await cut([{ file: f('a.mp4'), start: 0, duration: 1.5 }, { file: f('b.mp4'), start: 0.5, duration: 1 }], f('cut.mp4'))
    const cutInfo = await probe(f('cut.mp4'))
    assert.equal(cutInfo.durationSeconds, 2.5)
    assert.deepEqual([cutInfo.width, cutInfo.height, cutInfo.fps, cutInfo.hasAudio], [1920, 1080, 30, false])

    await grade(f('cut.mp4'), f('graded.mp4'), { contrast: 1.1, saturation: 1.2, brightness: 0.02, gamma: 1 })
    await mix([{ file: f('voz.mp3'), at: 1, volume: 1 }], 4, f('mix.mp3'))
    const mixInfo = await probe(f('mix.mp3'))
    assert.ok(Math.abs(mixInfo.durationSeconds! - 4) < 0.1, `la mezcla dura ${mixInfo.durationSeconds}`)

    // El cierre de marca alarga el video; el audio cubre los dos.
    await master({ video: f('graded.mp4'), endCard: f('a.mp4'), audio: f('mix.mp3'), supers: [{ image: f('super.png'), start: 0.5, end: 1.5 }], out: f('master.mp4') })
    const m = await probe(f('master.mp4'))
    assert.ok(Math.abs(m.durationSeconds! - 4.5) < 0.15, `el máster dura ${m.durationSeconds}`)
    assert.deepEqual([m.width, m.height, m.hasAudio], [1920, 1080, true])
    assert.ok(m.lufs !== null && m.lufs < 0)

    await reframe(f('master.mp4'), f('vertical.mp4'), '9:16', 'fit')
    const v = await probe(f('vertical.mp4'))
    assert.deepEqual([v.width, v.height, v.hasAudio], [1080, 1920, true])

    await preview(f('master.mp4'), f('hoja.jpg'), m.durationSeconds)
    assert.equal((await probe(f('hoja.jpg'))).width, 1280)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
