-- Esquema inicial (11/nov/2026): ajustes, marcas, proyectos, etapas, pasos de agente y eventos.
-- Las tablas solo las toca el servidor. Con RLS activo y sin políticas, el navegador no puede leerlas.

create table if not exists settings (key text primary key, value text not null);
create table if not exists brands (name text primary key, kit text not null);
create table if not exists projects (
  id text primary key, name text not null, brief text not null, scheme text not null, brand text,
  status text not null, reason text, budget_cap double precision not null, spent double precision not null default 0,
  created_at text not null
);
create table if not exists stages (
  project_id text not null, stage text not null, status text not null, attempts integer not null default 0,
  primary key (project_id, stage)
);
create table if not exists steps (
  project_id text not null, stage text not null, agent text not null, version integer not null,
  status text not null, feedback text, model text, done_at text not null,
  primary key (project_id, stage, agent, version)
);
create table if not exists events (
  id integer generated always as identity primary key, project_id text not null, ts text not null, type text not null, data text not null
);
create index if not exists events_project on events (project_id, id);

alter table settings enable row level security;
alter table brands enable row level security;
alter table projects enable row level security;
alter table stages enable row level security;
alter table steps enable row level security;
alter table events enable row level security;
