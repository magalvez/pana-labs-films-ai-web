import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Measurements } from '../engine/types.ts'

const exec = promisify(execFile)

/** Formato de trabajo de todo el montaje. Las versiones verticales y cuadradas salen de aquí. */
export const FPS = 30
export const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] } as const
export type Aspect = keyof typeof SIZES

async function run(bin: 'ffmpeg' | 'ffprobe', args: string[]) {
  try {
    return await exec(bin, args, { maxBuffer: 32 * 1024 * 1024 })
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new Error(`${bin} no está instalado en el servidor. Instálalo con: brew install ffmpeg`)
    // Las últimas líneas de ffmpeg dicen qué falló; el resto es ruido de configuración.
    throw new Error(`${bin} falló: ${String(err?.stderr ?? err?.message ?? err).trim().split('\n').slice(-3).join(' | ')}`)
  }
}
const ffmpeg = (...args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
/** Lleva cualquier clip al tamaño de trabajo sin deformarlo: escala y rellena con negro. */
const fit = ([w, h]: readonly [number, number]) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`

export async function probe(file: string): Promise<Measurements> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
  const info = JSON.parse(stdout)
  const video = info.streams?.find((s: any) => s.codec_type === 'video')
  const audio = info.streams?.find((s: any) => s.codec_type === 'audio')
  const [num, den] = String(video?.avg_frame_rate ?? '').split('/').map(Number)
  const duration = Number(info.format?.duration)
  // Una imagen fija no tiene duración ni cuadros por segundo que valga la pena reportar.
  const still = !audio && (!Number.isFinite(duration) || ['mjpeg', 'png', 'webp', 'bmp', 'gif'].includes(video?.codec_name))
  let lufs: number | null = null
  if (audio) {
    // ffmpeg informa la sonoridad integrada (EBU R128) al final de su salida de diagnóstico.
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'])
    // El silencio absoluto se informa como "-inf": se deja sin valor.
    const match = stderr.match(/Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/)
    lufs = match ? Number(match[1]) : null
  }
  return {
    durationSeconds: still || !Number.isFinite(duration) ? null : Math.round(duration * 100) / 100,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: still || !den ? null : Math.round((num / den) * 100) / 100,
    hasAudio: Boolean(audio),
    lufs,
  }
}

/** Imagen reducida para que un agente la mire. De un video saca cuatro cuadros repartidos, en una sola hoja. */
export async function preview(file: string, out: string, durationSeconds: number | null) {
  if (durationSeconds) await ffmpeg('-i', file, '-vf', `fps=4/${Math.max(durationSeconds, 0.2)},scale=640:-2,tile=2x2`, '-frames:v', '1', '-q:v', '4', out)
  else await ffmpeg('-i', file, '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', '-frames:v', '1', '-q:v', '4', out)
}

/** Une los tramos elegidos de cada toma, sin audio, en 16:9. */
export async function cut(clips: { file: string; start: number; duration: number }[], out: string) {
  const inputs = clips.flatMap((c) => ['-ss', String(c.start), '-t', String(c.duration), '-i', c.file])
  const graph = clips.map((_, i) => `[${i}:v]${fit(SIZES['16:9'])}[v${i}]`).join(';') + `;${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[v]`
  await ffmpeg(...inputs, '-filter_complex', graph, '-map', '[v]', '-an', ...H264, out)
}

export type Grade = { contrast: number; saturation: number; brightness: number; gamma: number }
export async function grade(file: string, out: string, g: Grade) {
  await ffmpeg('-i', file, '-vf', `eq=contrast=${g.contrast}:saturation=${g.saturation}:brightness=${g.brightness}:gamma=${g.gamma}`, '-an', ...H264, out)
}

/** Mezcla pistas en una sola, de duración exacta y normalizada a la sonoridad objetivo. */
export async function mix(tracks: { file: string; at: number; volume: number }[], durationSeconds: number, out: string, targetLufs = -14) {
  const inputs = tracks.flatMap((t) => ['-i', t.file])
  const base = tracks.length
  const chains = tracks.map((t, i) => `[${i}:a]aresample=44100,adelay=${Math.round(t.at * 1000)}:all=1,volume=${t.volume}[a${i}]`)
  // La pista de silencio garantiza la duración aunque todas las demás sean cortas.
  const graph = [...chains, `${tracks.map((_, i) => `[a${i}]`).join('')}[${base}:a]amix=inputs=${base + 1}:normalize=0:duration=longest,atrim=0:${durationSeconds},loudnorm=I=${targetLufs}:TP=-1.5:LRA=11[a]`].join(';')
  await ffmpeg(...inputs, '-f', 'lavfi', '-t', String(durationSeconds), '-i', 'anullsrc=r=44100:cl=stereo', '-filter_complex', graph, '-map', '[a]', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', out)
}

/** Corte + cierre de marca + textos en pantalla + mezcla de audio. La duración la manda el video. */
export async function master(o: { video: string; endCard?: string; audio?: string; supers: { image: string; start: number; end: number }[]; out: string }) {
  const size = SIZES['16:9']
  const inputs = ['-i', o.video]
  const graph = [`[0:v]${fit(size)}[main]`]
  let n = 1
  let last = 'main'
  if (o.endCard) {
    inputs.push('-i', o.endCard)
    graph.push(`[${n}:v]${fit(size)}[end]`, `[main][end]concat=n=2:v=1:a=0[joined]`)
    last = 'joined'
    n++
  }
  for (const s of o.supers) {
    inputs.push('-i', s.image)
    graph.push(`[${last}][${n}:v]overlay=0:0:enable='between(t,${s.start},${s.end})'[s${n}]`)
    last = `s${n}`
    n++
  }
  const audio = o.audio ? ['-i', o.audio] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']
  await ffmpeg(...inputs, ...audio, '-filter_complex', graph.join(';'), '-map', `[${last}]`, '-map', `${n}:a`, '-af', 'apad', '-shortest', ...H264, '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', o.out)
}

/** Reencuadra la pieza a otro formato. `fit` conserva todo el cuadro sobre un fondo desenfocado; `crop` recorta al centro. */
export async function reframe(file: string, out: string, aspect: Aspect, mode: 'fit' | 'crop') {
  const [w, h] = SIZES[aspect]
  const graph = mode === 'crop'
    ? `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[v]`
    : `[0:v]split[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:2[bg];[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`
  await ffmpeg('-i', file, '-filter_complex', graph, '-map', '[v]', '-map', '0:a?', ...H264, '-c:a', 'copy', out)
}

/** Archivo de muestra para el modo simulación: no llama a ningún proveedor. */
export async function sample(kind: 'image' | 'video' | 'audio', out: string) {
  if (kind === 'image') await ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', out)
  else if (kind === 'audio') await ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', out)
  else await ffmpeg('-f', 'lavfi', '-i', `testsrc2=s=640x360:r=${FPS}:d=2`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', ...H264, '-c:a', 'aac', out)
}
