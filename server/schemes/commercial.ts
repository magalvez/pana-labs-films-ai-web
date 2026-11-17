import type { AgentDef, Scheme, ToolFamily } from '../engine/types.ts'

const a = (id: string, name: string, ...deliverables: string[]): AgentDef => ({ id, name, deliverables })
/** Agente con herramientas de generación o montaje. Lo que produce con ellas se suma a sus entregables fijos. */
const t = (tools: ToolFamily[], id: string, name: string, ...deliverables: string[]): AgentDef => ({ id, name, deliverables, tools })

/** Esquema de comercial publicitario, según documentation/Pana Films Lab.docx. */
export const commercial: Scheme = {
  id: 'commercial',
  name: 'Comercial publicitario',
  stages: [
    {
      id: 'strategy',
      name: 'Strategy & Development',
      gate: 'Concepto y guion',
      auditor: { id: 'strategy-auditor', name: 'Strategy Auditor' },
      agents: [
        a('brief-strategy', 'Brief & Strategy Agent', 'brief-analysis.md'),
        a('brand-market-research', 'Brand & Market Research Agent', 'brand-research.md'),
        a('story-architect', 'Story Architect Agent', 'script.md', 'story-bible.md'),
        a('concept-pitch', 'Concept & Pitch Agent', 'treatment.md', 'lookbook.md'),
      ],
    },
    {
      id: 'preproduction',
      name: 'Pre-production',
      gate: 'Storyboard, estilo y presupuesto',
      auditor: { id: 'preproduction-auditor', name: 'Pre-production Auditor' },
      agents: [
        a('producer-budget', 'Producer / Budget Agent', 'budget.json'),
        a('art-director', 'Art Director Agent', 'art-direction.md'),
        t(['image'], 'character-talent-design', 'Character & Talent Design Agent', 'characters.md'),
        t(['image'], 'world-location', 'World & Location Agent', 'locations.md'),
        a('product-fidelity', 'Product Fidelity Agent', 'product-assets.md'),
        // El storyboard en imágenes es la aprobación barata: cada cuadro es la imagen de partida de su toma.
        t(['image'], 'storyboard-previs', 'Storyboard & Previs Agent', 'shots.json', 'storyboard.md'),
        a('legal-compliance', 'Legal & Compliance Agent', 'legal-review.md'),
      ],
    },
    {
      id: 'production',
      name: 'Production',
      gate: 'Tomas finales',
      auditor: { id: 'production-auditor', name: 'Production Auditor' },
      agents: [
        a('cinematography', 'Cinematography Agent', 'shot-specs.json'),
        t(['image', 'video'], 'generation-operators', 'Generation Operator Agents', 'takes.json'),
        t(['voice'], 'voice-performance', 'Voice & Performance Agent', 'voice.json'),
        a('continuity', 'Continuity Agent', 'continuity-report.md'),
        a('dailies-review', 'Dailies Review Agent', 'selects.json'),
      ],
    },
    {
      id: 'postproduction',
      name: 'Post-production',
      gate: 'Corte final',
      auditor: { id: 'postproduction-auditor', name: 'Post-production Auditor' },
      agents: [
        t(['cut'], 'editor', 'Editor Agent', 'edit.json', 'cut.mp4'),
        a('vfx-cleanup', 'VFX & Cleanup Agent', 'vfx-report.md'),
        t(['grade'], 'color', 'Color Agent', 'color-report.md', 'graded.mp4'),
        t(['music', 'sfx', 'mix'], 'sound-music', 'Sound Designer & Music Agent', 'audio-mix.json', 'mix.mp3'),
        t(['titles', 'master'], 'motion-graphics', 'Motion Graphics Agent', 'graphics.json', 'master.mp4'),
        a('localization', 'Localization Agent', 'subtitles.srt'),
        a('qc', 'QC Agent', 'qc-report.md'),
      ],
    },
    {
      id: 'delivery',
      name: 'Delivery & Performance',
      gate: 'Cumplimiento y entrega',
      auditor: { id: 'delivery-auditor', name: 'Delivery Auditor' },
      agents: [
        t(['versions'], 'versioning', 'Versioning Agent', 'versions.json'),
        t(['provenance'], 'disclosure-metadata', 'Disclosure & Metadata Agent', 'provenance.json'),
        a('delivery', 'Delivery Agent', 'delivery-manifest.json'),
        a('performance-analyst', 'Performance Analyst Agent', 'variants.md'),
      ],
    },
  ],
}
