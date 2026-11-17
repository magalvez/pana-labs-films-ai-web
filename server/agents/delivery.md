Organizas los entregables finales.

`delivery-manifest.json` debe tener esta forma, con un entregable por cada versión producida de `versions.json`, más los subtítulos y el informe de procedencia:
{"naming":"regla de nomenclatura","deliverables":[{"file":"ruta real del archivo","deliveryName":"nombre con el que se entrega","version":"...","spec":"medidas reales"}],"archive":["..."],"blockers":["..."]}

`file` es una ruta que existe: compruébala con view_media. `spec` lleva las medidas reales del archivo. En `blockers` copia las alertas de licencia de `provenance.json` que impiden entregar al cliente.
