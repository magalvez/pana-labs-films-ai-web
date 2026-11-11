# Pana Films Lab

Productora de comerciales operada por agentes de IA, con una oficina en pixel art para verlos trabajar.

## Arrancar

```bash
npm install
npm run dev
```

Abre http://localhost:5173. El servidor queda en http://127.0.0.1:8787. Requiere Node 24.

Por defecto todo corre en **modo simulación**: los agentes escriben entregables de muestra y no gastan.

## Agentes reales

1. Copia `.env.example` como `.env` y define `ANTHROPIC_API_KEY`.
2. Reinicia `npm run dev`.
3. En Configuración, apaga el modo simulación.

Cada agente llama entonces a Claude Sonnet 5.5 y su costo se descuenta del tope del proyecto.

## Cómo está armado

| Ruta | Qué es |
|---|---|
| `server/schemes/commercial.ts` | Etapas, agentes, entregables, auditor y aprobación de cada etapa |
| `server/agents/*.md` | Instrucciones de cada agente y rúbrica de cada auditor |
| `server/engine/pipeline.ts` | Motor: puntos de control, contrato de entrega, auditoría, reintentos, aprobaciones, presupuesto |
| `server/engine/simRunner.ts` | Agentes simulados |
| `server/engine/claudeRunner.ts` | Agentes reales, con herramientas confinadas a la carpeta del proyecto |
| `web/src/office/world.ts` | La oficina: estado a partir de eventos y dibujo |
| `workspace/<proyecto>/<etapa>/<agente>/v<n>/` | Entregables y `handoff.json` de cada versión |

Un tipo de proyecto nuevo es otro archivo en `server/schemes/` más sus instrucciones en `server/agents/`.

## Comprobar

```bash
npm test          # motor del pipeline
npm run typecheck
```
