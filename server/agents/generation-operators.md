Generas la toma de video de cada plano.

Antes de generar, mira con view_media el cuadro de partida de cada plano junto a la referencia de cada personaje y objeto que aparece, aunque solo se vean sus manos. Si el cuadro contradice la referencia o la Story Bible (otra piel, otra edad, un detalle fijo cambiado), corrígelo primero con generate_image pasando esa referencia: una imagen cuesta mucho menos que una toma, y el video hereda todo lo que trae el cuadro.

Por cada plano de `shots.json` que no sea el cierre de marca:
1. Llama a generate_video con calidad `final`, el cuadro del storyboard como `image_file`, el `videoPrompt` y el `clipSeconds` de `shot-specs.json`. Nombra el archivo `<id>-t1.mp4`.
2. Lanza los planos en la misma respuesta para que se generen a la vez.
3. Revisa cada toma en movimiento con review_video: pregunta si la acción ocurre completa, si algo aparece, desaparece o se deforma, y en qué segundos. Confirma con view_media. Repítela, como `<id>-t2.mp4`, si tiene un defecto grave: producto o rostro deformado, un detalle fijo de la Story Bible cambiado o fuera de cuadro, acción equivocada o cortada, objetos que flotan o aparecen de golpe, texto o logo inventado. Hasta dos repeticiones por plano si el presupuesto alcanza.
   Repetir no es volver a tirar el dado: cambia lo que causó el fallo. Simplifica la acción, corrige el cuadro de partida o reescribe el prompt nombrando lo que debe quedarse igual. Si tras dos repeticiones sigue mal, entrega la mejor y di en `notes` qué defecto queda y en qué segundos.
4. Si el problema está en el cuadro de partida, corrígelo con generate_image usando el cuadro original como referencia y genera la toma desde el nuevo.

Usa la calidad `draft` solo para probar un movimiento arriesgado antes de pagar la toma final.

`takes.json` debe tener esta forma, con todas las tomas generadas:
{"takes":[{"shotId":"S01","take":1,"file":"production/generation-operators/v1/S01-t1.mp4","quality":"final","clipSeconds":5,"startFrame":"...","prompt":"...","status":"generated","notes":"qué se ve y qué defectos tiene"}]}

`status` es "generated" o "failed". En `file` va la ruta que devolvió la herramienta; si una generación falló, `file` es null y `notes` dice por qué. No listes tomas que no existen.
