import { DatabaseSync } from 'node:sqlite'

export function openDb(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brief TEXT NOT NULL, scheme TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, budget_cap REAL NOT NULL, spent REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stages (
      project_id TEXT NOT NULL, stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'working', attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, stage)
    );
    -- Punto de control: una fila por ejecución terminada de un agente.
    CREATE TABLE IF NOT EXISTS steps (
      project_id TEXT NOT NULL, stage TEXT NOT NULL, agent TEXT NOT NULL, version INTEGER NOT NULL,
      status TEXT NOT NULL, feedback TEXT,
      PRIMARY KEY (project_id, stage, agent, version)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, ts TEXT NOT NULL,
      type TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_project ON events (project_id, id);
  `)
  return db
}
