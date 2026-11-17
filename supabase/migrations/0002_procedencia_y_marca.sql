-- Fase 4 (17/nov/2026): registro de procedencia de cada archivo generado o montado.
-- Guarda con qué herramienta, modelo y prompt se hizo, cuánto costó, su licencia y sus medidas técnicas.
-- De aquí salen el informe del Disclosure & Metadata Agent y las mediciones que usan los auditores.
create table if not exists assets (
  id integer generated always as identity primary key,
  project_id text not null,
  path text not null,            -- relativa al proyecto: <etapa>/<agente>/v<n>/<archivo>
  kind text not null,            -- image | video | audio
  tool text not null,
  provider text not null,
  model text not null,
  prompt text,
  seed text,
  inputs text not null,          -- JSON: archivos de los que se derivó
  cost_usd double precision not null default 0,
  license text not null,
  measurements text,             -- JSON: {durationSeconds,width,height,fps,hasAudio,lufs}
  created_at text not null
);
create index if not exists assets_project on assets (project_id, id);
alter table assets enable row level security;
