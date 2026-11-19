import { useEffect, useState } from 'react'
import { api } from './api'
import type { SchemeT } from './office/world'
import { Regression, TelegramLink } from './Extras'

export type Settings = { humanReview: boolean; simulation: boolean; models: Record<string, string>; maxAuditRetries: number; textTimeoutMin: number; mediaTimeoutMin: number; defaultBudget: number; imageModel: string; videoModel: string; parallelAgents: boolean }
type Gen = { id: string; name: string; note: string; price: string }
type Models = { image: Gen[]; video: Gen[]; models: { id: string; name: string; note: string }[]; default: string; recommended: Record<string, string> }
type Act = (fn: () => Promise<unknown>) => Promise<boolean>

/** Un número que se guarda al salir del campo, no en cada tecla. */
function Limit({ label, hint, value, min, max, unit, onSave }: { label: string; hint: string; value: number; min: number; max: number; unit: string; onSave: (n: number) => Promise<boolean> }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const save = () => { const n = Math.round(Number(draft)); if (n >= min && n <= max && n !== value) void onSave(n).then((ok) => { if (!ok) setDraft(String(value)) }); else setDraft(String(value)) }
  return (
    <label className="limit">
      <span><strong>{label}</strong>{hint}</span>
      <span className="limit-input"><input type="number" min={min} max={max} step="1" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />{unit}</span>
    </label>
  )
}

/** Configuración del estudio: lo que vale para todas las producciones. */
export function Config({ settings, schemes, admin, act, onChange }: { settings: Settings; schemes: SchemeT[]; admin: boolean; act: Act; onChange: (s: Settings) => void }) {
  const [catalog, setCatalog] = useState<Models | null>(null)
  useEffect(() => { if (admin) void act(async () => setCatalog(await api<Models>('/models'))) }, [admin])
  const save = (patch: Partial<Omit<Settings, 'models'>> & { models?: Record<string, string | null> }) => act(async () => onChange(await api<Settings>('/settings', 'PUT', patch)))
  const modelOf = (id: string) => settings.models[id] ?? catalog?.default ?? ''
  const changed = Object.keys(settings.models).length

  return (
    <div className="backlot team config">
      <header className="backlot-head">
        <h2>Configuración</h2>
        <p>{admin ? 'Lo que vale para todo el estudio. Cada cambio se guarda al instante y lo toma el siguiente agente que empiece a trabajar, también en las producciones en curso.' : 'Tus avisos. El resto de la configuración del estudio la llevan los administradores.'}</p>
      </header>

      <div className="config-grid">
        <TelegramLink act={act} />
        {admin && <>
        <section className="credits" aria-label="General">
          <h3>General</h3>
          <label className="check"><input type="checkbox" checked={settings.humanReview} onChange={(e) => save({ humanReview: e.target.checked })} />
            <span><strong>Revisión humana en cada etapa</strong>Cuando el auditor aprueba una etapa, el proyecto espera tu visto bueno. Apagada, avanza solo. El auditor corre siempre.</span></label>
          <label className="check"><input type="checkbox" checked={settings.parallelAgents} onChange={(e) => save({ parallelAgents: e.target.checked })} />
            <span><strong>Agentes en paralelo</strong>Dentro de una etapa, los agentes que no dependen del anterior trabajan a la vez (por ejemplo, locaciones y fidelidad de producto junto al diseño de personajes). Acorta el tiempo de producción sin cambiar el costo. Apagado, van de uno en uno.</span></label>
          <label className="check"><input type="checkbox" checked={settings.simulation} onChange={(e) => save({ simulation: e.target.checked })} />
            <span><strong>Modo simulación</strong>Los agentes escriben entregables de muestra y no gastan. Apagado, cada agente llama a Claude y genera imagen, video, voz y música de verdad. Vale para los proyectos nuevos: cada proyecto conserva el modo con el que se creó.</span></label>
        </section>

        <section className="credits" aria-label="Límites del motor">
          <h3>Límites del motor</h3>
          <Limit label="Rechazos del auditor antes de pedirte decisión" hint="Con menos, una etapa difícil te llega antes y gasta menos en repeticiones." value={settings.maxAuditRetries + 1} min={1} max={6} unit="rechazos" onSave={(n) => save({ maxAuditRetries: n - 1 })} />
          <Limit label="Tiempo máximo de un agente de texto" hint="Pasado este tiempo el agente se detiene y la producción queda lista para reintentar." value={settings.textTimeoutMin} min={5} max={60} unit="min" onSave={(n) => save({ textTimeoutMin: n })} />
          <Limit label="Tiempo máximo de un agente que genera o monta" hint="Incluye a los auditores. Cada toma de video tarda varios minutos." value={settings.mediaTimeoutMin} min={15} max={180} unit="min" onSave={(n) => save({ mediaTimeoutMin: n })} />
          <Limit label="Tope de presupuesto de un proyecto nuevo" hint="El valor que aparece al crear un proyecto. Se puede cambiar en cada uno." value={settings.defaultBudget} min={1} max={10000} unit="USD" onSave={(n) => save({ defaultBudget: n })} />
        </section>

        <section className="credits models" aria-label="Modelos de generación">
          <h3>Modelos de generación</h3>
          {catalog && ([['imageModel', 'Imágenes: personajes, locaciones y storyboard', catalog.image], ['videoModel', 'Toma final de video', catalog.video]] as const).map(([key, label, options]) => (
            <label key={key} className="limit">
              <span><strong>{label}</strong>{options.map((o) => `${o.name}: ${o.price}. ${o.note}`).join(' ')}</span>
              <select value={settings[key]} onChange={(e) => save({ [key]: e.target.value })}>{options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
            </label>
          ))}
          <p className="note">Todo se genera en fal.ai con la misma clave. El cambio vale para la siguiente imagen o toma, también en producciones en curso: conviene no mezclar modelos de video dentro de un mismo comercial.</p>
        </section>

        <section className="credits models" aria-label="Modelo de cada agente">
          <h3>Modelo de cada agente</h3>
          {catalog && <>
            <ul className="model-key">{catalog.models.map((m) => <li key={m.id}><strong>{m.name}</strong> {m.note}</li>)}</ul>
            <p className="model-actions">
              <button onClick={() => save({ models: catalog.recommended })}>Aplicar los recomendados</button>
              <button disabled={!changed} onClick={() => save({ models: Object.fromEntries(Object.keys(settings.models).map((id) => [id, null])) })}>Volver todos a {catalog.models.find((m) => m.id === catalog.default)?.name}</button>
              <span role="status">{changed ? `${changed} agente${changed > 1 ? 's' : ''} con un modelo distinto del de por defecto.` : 'Todos usan el modelo por defecto.'}</span>
            </p>
            {schemes.map((scheme) => scheme.stages.map((stage) => (
              <table key={`${scheme.id}/${stage.id}`}>
                <caption>{stage.name}</caption>
                <tbody>{[...stage.agents, stage.auditor].map((a) => (
                  <tr key={a.id} className={settings.models[a.id] ? 'custom' : ''}>
                    <th scope="row">{a.name}{a.id === stage.auditor.id && <em> (auditor)</em>}</th>
                    <td>{catalog.recommended[a.id] && catalog.recommended[a.id] !== modelOf(a.id) && <small>Recomendado: {catalog.models.find((m) => m.id === catalog.recommended[a.id])?.name}</small>}</td>
                    <td>
                      <select aria-label={`Modelo de ${a.name}`} value={modelOf(a.id)} onChange={(e) => {
                        void save({ models: { [a.id]: e.target.value === catalog.default ? null : e.target.value } })
                      }}>
                        {catalog.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )))}
            <p className="note">Un modelo más barato en un agente que juzga imágenes o decide calidad puede traer más rechazos del auditor y salir más caro. El costo de cada producción se calcula con el precio del modelo que usó cada agente.</p>
          </>}
        </section>
        <Regression act={act} budget={settings.defaultBudget} />
        </>}
      </div>
    </div>
  )
}
