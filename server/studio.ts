import type { Engine } from './engine/pipeline.ts'
import type { Card, Studio, Telegram } from './telegram.ts'
import type { Users } from './users.ts'

const short = (name: string) => name.split(' ')[0].replace('-production', '').replace(/^Production$/, 'Prod')

/** Lo que el bot de Telegram puede ver y hacer en el estudio. Todo pasa por el motor, igual que desde la pantalla. */
export function createStudio(engine: Engine, users: Pick<Users, 'roleOf'>): Studio {
  async function card(id: string): Promise<Card> {
    const p = await engine.getProject(id)
    const stages = engine.schemes[p.scheme].stages
    const at = p.currentStage ? stages.findIndex((s) => s.id === p.currentStage) : stages.length
    const s = stages[at]
    return {
      id: p.id, name: p.name, status: p.status, reason: p.reason, spent: p.spent, cap: p.budget_cap, at,
      stage: s ? { id: s.id, name: s.name.split(' & ')[0], gate: s.gate } : null,
      stages: stages.map((x) => ({ id: x.id, label: short(x.name), name: x.name.split(' & ')[0] })),
    }
  }
  const stageOf = async (id: string) => { const p = await engine.getProject(id); return { p, stage: engine.schemes[p.scheme].stages.find((s) => s.id === p.currentStage) } }
  /** El botón de un aviso viejo no decide una etapa posterior que nadie ha revisado. */
  async function stillWaiting(id: string, stage: string) {
    const p = await engine.getProject(id)
    if (p.status !== 'waiting_human' || p.currentStage !== stage) throw Object.assign(new Error('La etapa se decidió o el proyecto avanzó. Mira el aviso más reciente.'), { stale: true })
  }
  return {
    roleOf: (email) => users.roleOf(email),
    card,
    // ponytail: una consulta por producción; con cientos de producciones convendría una sola consulta resumida.
    async list() {
      const rows = (await engine.listProjects()).filter((p) => p.status !== 'cancelled').slice(0, 8)
      return Promise.all(rows.map((p) => card(p.id)))
    },
    async audit(id) {
      const { stage } = await stageOf(id)
      if (!stage) return null
      const last = (await engine.eventsAfter(id)).filter((e) => e.type === 'audit.verdict' && e.data.stage === stage.id).at(-1)
      if (!last) return null
      return { approved: last.data.approved === true, attempt: Number(last.data.attempt) || 1, issues: (last.data.issues ?? []).map((i: any) => String(i.problem)), agents: stage.agents.length, files: stage.agents.reduce((n, a) => n + a.deliverables.length, 0) }
    },
    async delivered(id) {
      const { p, stage } = await stageOf(id)
      if (!stage) return []
      return stage.agents.map((a) => ({ agent: a.name.replace(/ Agents?$/, ''), version: Math.max(1, ...p.steps.filter((s) => s.stage === stage.id && s.agent === a.id).map((s) => s.version)), files: a.deliverables }))
    },
    async summary(id) {
      const [r, p] = await Promise.all([engine.costReport(id), engine.getProject(id)])
      const minutes = r.startedAt && r.lastActivityAt ? Math.max(0, Math.round((Date.parse(r.lastActivityAt) - Date.parse(r.startedAt)) / 60_000)) : 0
      return { minutes, reworks: p.steps.filter((s) => s.version > 1).length, totalUsd: r.totalUsd, modelUsd: r.modelUsd, generationUsd: r.generationUsd, reworkUsd: r.reworkUsd, byStage: r.byStage.map((s) => ({ name: s.name.split(' & ')[0], usd: s.usd })) }
    },
    async approve(id, stage) { await stillWaiting(id, stage); await engine.decide(id, { approve: true }) },
    async sendBack(id, stage, _email, comment) { await stillWaiting(id, stage); await engine.decide(id, { approve: false, comment }) },
    async raise(id, extra) {
      const p = await engine.getProject(id)
      if (p.status === 'paused' || p.status === 'failed') await engine.resume(id, p.budget_cap + extra)
      else await engine.setBudget(id, p.budget_cap + extra)
      return card(id)
    },
    cancel: (id) => engine.cancel(id),
    retry: (id) => engine.resume(id),
    improve: (id, stage, text, budget, email) => engine.requestImprovement(id, stage, text, budget, email),
    async note(id, noteId) { return (await engine.listClientFeedback(id)).find((n) => n.id === noteId) ?? null },
    async resolve(id, noteId, status) { await engine.resolveClientFeedback(id, noteId, status) },
  }
}

/** Lo que merece un aviso fuera de la app: una decisión pendiente, el tope alcanzado, un fallo, la entrega y la opinión del cliente. */
export function studioNotice(telegram: Pick<Telegram, 'announce'>) {
  return async (projectId: string, type: string, data: Record<string, any>) => {
    if (type === 'client.feedback') return telegram.announce(projectId, { id: data.id, kind: data.kind, about: data.about, name: data.name, text: data.text })
    const status = type === 'project.status' ? data.status : null
    if (['waiting_human', 'done', 'failed'].includes(status) || (status === 'paused' && data.reason === 'budget')) return telegram.announce(projectId)
  }
}
