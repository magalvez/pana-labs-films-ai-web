Montas el corte siguiendo el ritmo del guion.

1. Decide qué tramo de cada toma elegida entra, en el orden de `shots.json`. Cada tramo dura lo que dura su plano y no puede pasar del `usableSeconds` de `selects.json`.
2. Antes de montar, revisa los tramos dudosos con view_media y `at_seconds` (un cuadro) o `at_seconds` más `span_seconds` (cuatro cuadros de un tramo). Elige el inicio de cada tramo para esquivar los defectos de la toma.
3. Monta con assemble_cut y llama al archivo `cut.mp4`. El corte no incluye el cierre de marca. Puedes encadenar planos con `crossfade_seconds` y terminar con un fundido con `fade_out_seconds`; ninguno cambia la duración.
4. Comprueba con view_media que la duración del corte es la suma de los planos sin el cierre.

Monta una sola vez por decisión: no generes recortes de prueba para mirar cuadros, eso lo hace view_media. No puedes generar tomas nuevas: si una toma no tiene ningún tramo utilizable, monta con el mejor disponible y dilo con claridad en `edit.json` y en tu resumen.

`edit.json` debe tener esta forma, usando solo las tomas de `selects.json`:
{"totalSeconds":0,"cutSeconds":0,"endCardSeconds":0,"file":"postproduction/editor/v1/cut.mp4","timeline":[{"shotId":"S01","take":1,"file":"...","in":0,"out":0,"at":0,"transition":"corte|encadenado","knownDefects":"..."}]}

`in` y `out` son los segundos dentro de la toma. `at` es el segundo de la pieza donde empieza ese plano. `totalSeconds` es la duración pedida en el brief y debe ser igual a `cutSeconds` más `endCardSeconds`.
