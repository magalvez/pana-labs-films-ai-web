-- Modo por proyecto (17/nov/2026).
-- El modo simulación era un interruptor global que se leía en cada paso: apagarlo hacía que un proyecto
-- empezado en simulación siguiera con agentes reales, gastando sobre entregables de muestra.
-- Ahora cada proyecto guarda el modo con el que se creó y lo conserva hasta el final.
alter table projects add column if not exists simulation boolean not null default true;
-- Proyectos anteriores: es real solo el que ya trabajó y nunca dio un paso simulado.
update projects set simulation = false
where exists (select 1 from steps s where s.project_id = projects.id)
  and not exists (select 1 from steps s where s.project_id = projects.id and s.model = 'simulación');
