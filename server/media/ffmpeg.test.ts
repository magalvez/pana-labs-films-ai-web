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

    // Encadenado entre planos, fundido final y encadenado al cierre: ninguno cambia la duración.
    await cut([{ file: f('a.mp4'), start: 0, duration: 1 }, { file: f('b.mp4'), start: 0, duration: 1, crossfade: 0.4 }], f('suave.mp4'), { seconds: 0.3, color: '#2b1a12' })
    assert.equal((await probe(f('suave.mp4'))).durationSeconds, 2)
    await grade(f('suave.mp4'), f('suave-color.mp4'), { contrast: 1, saturation: 1, brightness: 0, gamma: 1 }, [{ from: 1, to: 2, contrast: 0.9, saturation: 0.8, brightness: 0.02, gamma: 1.1 }])
    assert.equal((await probe(f('suave-color.mp4'))).durationSeconds, 2)
    await master({ video: f('suave-color.mp4'), endCard: f('a.mp4'), endCardFade: 0.5, supers: [], out: f('master-suave.mp4') })
    assert.ok(Math.abs((await probe(f('master-suave.mp4'))).durationSeconds! - 4) < 0.15)
    // Un instante exacto y un tramo corto, para revisar un defecto.
    await preview(f('master.mp4'), f('instante.jpg'), m.durationSeconds, { at: 1.2, span: 0 })
    assert.equal((await probe(f('instante.jpg'))).width, 1280)
    await preview(f('master.mp4'), f('tramo.jpg'), m.durationSeconds, { at: 1, span: 0.5 })
    assert.equal((await probe(f('tramo.jpg'))).width, 1280)
    // Un encadenado sin material suficiente en la toma anterior falla con un mensaje claro, no con un corte más corto.
    await assert.rejects(cut([{ file: f('a.mp4'), start: 1.5, duration: 0.5 }, { file: f('b.mp4'), start: 0, duration: 1, crossfade: 0.5 }], f('corto.mp4')), /le falta material/)
    // Un fundido más largo que el corte no deja la pieza a medio fundir.
    await cut([{ file: f('a.mp4'), start: 0, duration: 0.5 }], f('fundido.mp4'), { seconds: 3, color: '#2b1a12' })
    assert.equal((await probe(f('fundido.mp4'))).durationSeconds, 0.5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
