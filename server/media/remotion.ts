import { bundle } from '@remotion/bundler'
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer'
import { join } from 'node:path'
import type { EndCardProps, SuperProps } from '../../remotion/Root.tsx'

// Remotion es gratis para empresas de hasta 3 personas. Con 4 o más hace falta la licencia de empresa
// (remotion.dev/license); entonces este valor pasa a ser la clave que entregan.
const licenseKey = process.env.REMOTION_LICENSE_KEY ?? 'free-license'

let ready: Promise<string> | undefined
/** El empaquetado y la descarga del navegador de render se hacen una vez por proceso. */
const serveUrl = () => (ready ??= (async () => {
  await ensureBrowser()
  return bundle({ entryPoint: join(import.meta.dirname, '..', '..', 'remotion', 'index.ts') })
})().catch((err) => { ready = undefined; throw err }))

/** Cierre de marca animado, en video. */
export async function renderEndCard(props: EndCardProps, out: string) {
  const url = await serveUrl()
  const composition = await selectComposition({ serveUrl: url, id: 'EndCard', inputProps: props })
  await renderMedia({ composition, serveUrl: url, codec: 'h264', outputLocation: out, inputProps: props, logLevel: 'error', licenseKey })
}

/** Texto en pantalla como imagen con transparencia. */
export async function renderSuper(props: SuperProps, out: string) {
  const url = await serveUrl()
  const composition = await selectComposition({ serveUrl: url, id: 'Super', inputProps: props })
  await renderStill({ composition, serveUrl: url, output: out, imageFormat: 'png', inputProps: props, logLevel: 'error', licenseKey })
}
