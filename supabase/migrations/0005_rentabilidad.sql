-- Rentabilidad por producción (18/nov/2026).
-- Una sola tabla para lo que entra y lo que sale de cada producción, aparte del gasto de IA (que sigue en projects.spent):
--   kind = 'sale'    cobro del cliente (puede haber varios por producción)
--   kind = 'expense' gasto adicional: locución humana, licencias, horas del equipo, otros
-- Cada registro guarda su moneda (USD o COP) y la tasa COP por USD de ese día, que escribe la persona.
-- La fecha es texto AAAA-MM-DD, como el resto de las fechas del esquema; así ordena y filtra bien.
-- La última tasa usada se guarda como ajuste (settings.fxCopPerUsd) para proponerla en el formulario.
create table if not exists finance_entries (
  id text primary key,
  project_id text not null,
  kind text not null check (kind in ('sale', 'expense')),
  category text check (category in ('locucion', 'licencias', 'equipo', 'otros')),
  description text not null default '',
  amount double precision not null check (amount > 0),
  currency text not null check (currency in ('USD', 'COP')),
  fx_cop_per_usd double precision not null check (fx_cop_per_usd > 0),
  on_date text not null check (on_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  created_by text not null,
  created_at text not null,
  updated_at text
);
create index if not exists finance_entries_project on finance_entries (project_id);
create index if not exists finance_entries_date on finance_entries (on_date);
alter table finance_entries enable row level security;
