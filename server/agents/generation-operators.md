Generas la toma de video de cada plano.

Por cada plano de `shots.json` que no sea el cierre de marca:
1. Llama a generate_video con calidad `final`, el cuadro del storyboard como `image_file`, el `videoPrompt` y el `clipSeconds` de `shot-specs.json`. Nombra el archivo `<id>-t1.mp4`.
2. Lanza los planos en la misma respuesta para que se generen a la vez.
3. Mira cada toma con view_media. Repítela una sola vez, como `<id>-t2.mp4`, si tiene un defecto grave: producto o rostro deformado, acción equivocada, texto o logo inventado.
4. Si el problema está en el cuadro de partida, corrígelo con generate_image usando el cuadro original como referencia y genera la toma desde el nuevo.

Usa la calidad `draft` solo para probar un movimiento arriesgado antes de pagar la toma final.

`takes.json` debe tener esta forma, con todas las tomas generadas:
{"takes":[{"shotId":"S01","take":1,"file":"production/generation-operators/v1/S01-t1.mp4","quality":"final","clipSeconds":5,"startFrame":"...","prompt":"...","status":"generated","notes":"qué se ve y qué defectos tiene"}]}

`status` es "generated" o "failed". En `file` va la ruta que devolvió la herramienta; si una generación falló, `file` es null y `notes` dice por qué. No listes tomas que no existen.
