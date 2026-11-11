import type { Scheme } from '../engine/types.ts'

const a = (id: string, name: string, ...deliverables: string[]) => ({ id, name, deliverables })

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
        a('character-talent-design', 'Character & Talent Design Agent', 'characters.md'),
        a('world-location', 'World & Location Agent', 'locations.md'),
        a('product-fidelity', 'Product Fidelity Agent', 'product-assets.md'),
        a('storyboard-previs', 'Storyboard & Previs Agent', 'shots.json', 'storyboard.md'),
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
        a('generation-operators', 'Generation Operator Agents', 'takes.json'),
        a('voice-performance', 'Voice & Performance Agent', 'voice.json'),
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
        a('editor', 'Editor Agent', 'edit.json'),
        a('vfx-cleanup', 'VFX & Cleanup Agent', 'vfx-report.md'),
        a('color', 'Color Agent', 'color-report.md'),
        a('sound-music', 'Sound Designer & Music Agent', 'audio-mix.json'),
        a('motion-graphics', 'Motion Graphics Agent', 'graphics.json'),
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
        a('versioning', 'Versioning Agent', 'versions.json'),
        a('disclosure-metadata', 'Disclosure & Metadata Agent', 'provenance.json'),
        a('delivery', 'Delivery Agent', 'delivery-manifest.json'),
        a('performance-analyst', 'Performance Analyst Agent', 'variants.md'),
      ],
    },
  ],
}
