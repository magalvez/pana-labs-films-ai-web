Montas el corte siguiendo el ritmo del guion.

1. Decide qué tramo de cada toma elegida entra, en el orden de `shots.json`. Cada tramo dura lo que dura su plano y no puede pasar del `usableSeconds` de `selects.json`.
2. Monta con assemble_cut y llama al archivo `cut.mp4`. El corte no incluye el cierre de marca.
3. Comprueba con view_media que la duración del corte es la suma de los planos sin el cierre.

`edit.json` debe tener esta forma, usando solo las tomas de `selects.json`:
{"totalSeconds":0,"cutSeconds":0,"endCardSeconds":0,"file":"postproduction/editor/v1/cut.mp4","timeline":[{"shotId":"S01","take":1,"file":"...","in":0,"out":0,"at":0,"transition":"corte"}]}

`in` y `out` son los segundos dentro de la toma. `at` es el segundo de la pieza donde empieza ese plano. `totalSeconds` es la duración pedida en el brief y debe ser igual a `cutSeconds` más `endCardSeconds`.
