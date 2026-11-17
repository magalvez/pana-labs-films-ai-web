import { AbsoluteFill, Composition, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'

const FPS = 30
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif'

export type EndCardProps = {
  /** Logo real del cliente como data URL. Si falta, el cierre muestra el nombre de la marca en texto. */
  logo: string | null
  brandName: string
  tagline: string
  cta: string
  background: string
  color: string
  accent: string
  width: number
  height: number
  durationSeconds: number
}

/** Cierre de marca: entra el logo, luego el lema y al final la llamada a la acción. */
function EndCard({ logo, brandName, tagline, cta, background, color, accent }: EndCardProps) {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const unit = Math.min(width, height) / 100
  const enter = spring({ frame, fps, config: { damping: 200 } })
  const fade = (from: number) => interpolate(frame, [from, from + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const rise = (from: number) => interpolate(frame, [from, from + 12], [unit * 2, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ background, color, fontFamily: FONT, alignItems: 'center', justifyContent: 'center', gap: unit * 4, padding: unit * 8, textAlign: 'center' }}>
      <div style={{ opacity: enter, transform: `scale(${0.86 + 0.14 * enter})` }}>
        {logo
          ? <Img src={logo} style={{ maxWidth: width * 0.5, maxHeight: height * 0.34, objectFit: 'contain' }} />
          : <div style={{ fontSize: unit * 11, fontWeight: 700, letterSpacing: -unit * 0.2 }}>{brandName}</div>}
      </div>
      {tagline && <div style={{ fontSize: unit * 5.2, fontWeight: 500, lineHeight: 1.2, maxWidth: width * 0.8, opacity: fade(14), transform: `translateY(${rise(14)}px)` }}>{tagline}</div>}
      {cta && <div style={{ fontSize: unit * 4.6, fontWeight: 700, color: accent, opacity: fade(28), transform: `translateY(${rise(28)}px)` }}>{cta}</div>}
    </AbsoluteFill>
  )
}

export type SuperProps = { text: string; position: 'top' | 'center' | 'bottom'; color: string; width: number; height: number }

/** Texto en pantalla sobre fondo transparente, dentro de la zona segura. Se superpone al video en el montaje. */
function Super({ text, position, color }: SuperProps) {
  const { width, height } = useVideoConfig()
  const unit = Math.min(width, height) / 100
  return (
    <AbsoluteFill style={{ fontFamily: FONT, alignItems: 'center', justifyContent: position === 'top' ? 'flex-start' : position === 'center' ? 'center' : 'flex-end', padding: `${height * 0.1}px ${width * 0.08}px` }}>
      <div style={{ color, fontSize: unit * 5.4, fontWeight: 700, lineHeight: 1.2, textAlign: 'center', maxWidth: width * 0.84, textShadow: `0 ${unit * 0.3}px ${unit * 1.6}px rgba(0,0,0,.75), 0 0 ${unit * 0.4}px rgba(0,0,0,.6)` }}>{text}</div>
    </AbsoluteFill>
  )
}

export function Root() {
  return (
    <>
      <Composition
        id="EndCard"
        component={EndCard}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={90}
        defaultProps={{ logo: null, brandName: 'Marca', tagline: '', cta: '', background: '#101418', color: '#ffffff', accent: '#f2b632', width: 1920, height: 1080, durationSeconds: 3 }}
        calculateMetadata={({ props }) => ({ width: props.width, height: props.height, durationInFrames: Math.max(1, Math.round(props.durationSeconds * FPS)) })}
      />
      <Composition
        id="Super"
        component={Super}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={1}
        defaultProps={{ text: '', position: 'bottom', color: '#ffffff', width: 1920, height: 1080 }}
        calculateMetadata={({ props }) => ({ width: props.width, height: props.height })}
      />
    </>
  )
}
