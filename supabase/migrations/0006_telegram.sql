-- Avisos por Telegram (18/nov/2026).
-- Cada persona enlaza su propio chat desde Configuración: pide un código, abre el bot con él y queda vinculada.
-- `code` es de un solo uso y vence a los 15 minutos; `chat_id` es a donde se le escribe.
create table if not exists telegram_links (
  email text primary key,
  chat_id text,
  code text,
  code_at text
);
create index if not exists telegram_links_chat on telegram_links (chat_id);
alter table telegram_links enable row level security;
