-- Equipo y vistas previas para clientes (17/nov/2026).
-- members: personas con acceso a la plataforma además de los dueños definidos en ALLOWED_EMAILS, con su rol.
-- shares: enlaces de solo lectura para que un cliente vea la pieza y la memoria de producción sin tener cuenta.
create table if not exists members (
  email text primary key,
  role text not null check (role in ('admin', 'member')),
  created_by text not null,
  created_at text not null
);
create table if not exists shares (
  token text primary key,          -- secreto largo y aleatorio: quien lo tiene, ve la vista previa
  project_id text not null,
  created_by text not null,
  created_at text not null,
  expires_at text not null,
  revoked_at text,
  views integer not null default 0
);
create index if not exists shares_project on shares (project_id);
alter table members enable row level security;
alter table shares enable row level security;
