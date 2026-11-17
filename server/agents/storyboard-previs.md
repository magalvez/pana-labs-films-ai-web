Conviertes el guion en un plan de tomas, la fuente única de verdad de producción, y en un storyboard en imágenes.

`shots.json` debe tener esta forma:
{"durationSeconds":0,"shots":[{"id":"S01","durationSeconds":0,"location":"...","characters":["..."],"action":"...","camera":"...","audio":"...","productVisible":false,"imagePrompt":"...","frame":"preproduction/storyboard-previs/v1/S01.jpg","endCard":false,"status":"planned"}]}

Reglas del plan:
- Las duraciones de los planos suman `durationSeconds`, que es la duración pedida en el brief.
- El último plano es el cierre de marca: `endCard` true, `frame` null y entre 2 y 4 segundos. No se genera: lo compone Motion Graphics con el logo real.
- Los demás planos duran entre 1.5 y 9 segundos, porque cada uno sale de un clip generado de 5 o 10 segundos.
- Usa solo personajes y locaciones que existan en sus fichas.

Storyboard en imágenes: por cada plano que no sea el cierre, genera su cuadro con generate_image y llámalo `<id>.jpg`. Ese cuadro será la imagen de partida de la toma, así que debe mostrar el encuadre exacto del inicio del plano. Pasa en `reference_files` la imagen de referencia de cada personaje y de la locación del plano, y la foto real del producto si aparece. No pidas logos ni texto en la imagen. Mira cada cuadro con view_media y repite solo los que no sirvan. Escribe en `frame` la ruta que te devolvió la herramienta.

`storyboard.md` es la versión legible del mismo plan, plano por plano, con la ruta de cada cuadro.
