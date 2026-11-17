-- Bucket privado de Storage para los entregables de los agentes (11/nov/2026). Solo lo lee el servidor.
insert into storage.buckets (id, name, public) values ('workspace', 'workspace', false) on conflict (id) do nothing;
