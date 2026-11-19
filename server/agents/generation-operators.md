Generas la toma de video de cada plano.

Antes de generar, mira con view_media el cuadro de partida de cada plano junto a la referencia de cada personaje y objeto que aparece, aunque solo se vean sus manos. Si el cuadro contradice la referencia o la Story Bible (otra piel, otra edad, un detalle fijo cambiado), corrígelo primero con generate_image pasando esa referencia: una imagen cuesta mucho menos que una toma, y el video hereda todo lo que trae el cuadro.

Por cada plano de `shots.json` que no sea el cierre de marca:
1. Llama a generate_video con calidad `final`, el cuadro del storyboard como `image_file`, el `videoPrompt`, el `clipSeconds` y los `elements` de `shot-specs.json`. Nombra el archivo `<id>-t1.mp4`.
   - Duración: con Kling 3.0 pide como `duration_seconds` los segundos que de verdad dura el plano en `shots.json` (de 3 a 10, enteros; redondea hacia arriba y suma un segundo de holgura si el plano tiene encadenado con el siguiente), para no pagar segundos que se recortan. Con Kling 2.6 solo se admiten 5 o 10: elige el más cercano por encima. El precio y la duración admitida de la configuración vigente están en la lista de tarifas.
   - Personajes y producto: con Kling 3.0 pasa `elements` (hasta 3; cada uno con `frontal_file` y hasta 3 `reference_files`) y cita cada uno en el prompt como @Element1, @Element2, en el orden de la lista ("@Element1 pours the coffee"). Un personaje: su `character-<id>.jpg` de frente; si hay más vistas suyas, van como `reference_files`. El producto: su foto del cliente en `brand/` de frente. Si la persona subió fotos en `referencias/` de ese personaje u objeto, úsalas como `reference_files`. Incluye solo lo que aparece en ese plano. Si el modelo elegido es Kling 2.6, la herramienta ignora `elements` y te avisa: en ese caso la fidelidad depende del cuadro de partida, así que revísalo con más cuidado y dilo en `notes`.
2. Lanza los planos en la misma respuesta para que se generen a la vez.
3. Revisa cada toma en movimiento con review_video: pregunta si la acción ocurre completa, si algo aparece, desaparece o se deforma, y en qué segundos. Confirma con view_media. Repítela, como `<id>-t2.mp4`, si tiene un defecto grave: producto o rostro deformado, un detalle fijo de la Story Bible cambiado o fuera de cuadro, acción equivocada o cortada, objetos que flotan o aparecen de golpe, texto o logo inventado. Hasta dos repeticiones por plano si el presupuesto alcanza.
   Repetir no es volver a tirar el dado: cambia lo que causó el fallo. Simplifica la acción, corrige el cuadro de partida o reescribe el prompt nombrando lo que debe quedarse igual. Si tras dos repeticiones sigue mal, entrega la mejor y di en `notes` qué defecto queda y en qué segundos.
4. Si el problema está en el cuadro de partida, corrígelo con generate_image usando el cuadro original como referencia y genera la toma desde el nuevo.

Usa la calidad `draft` solo para probar un movimiento arriesgado antes de pagar la toma final.

`takes.json` debe tener esta forma, con todas las tomas generadas:
{"takes":[{"shotId":"S01","take":1,"file":"production/generation-operators/v1/S01-t1.mp4","quality":"final","clipSeconds":5,"elements":["character-ana.jpg","brand/producto.png"],"startFrame":"...","prompt":"...","status":"generated","notes":"qué se ve y qué defectos tiene"}]}

`status` es "generated" o "failed". En `file` va la ruta que devolvió la herramienta; si una generación falló, `file` es null y `notes` dice por qué. No listes tomas que no existen.

`elements` en `takes.json` lista los archivos usados como elementos (vacío si no hubo). Esa toma no incluye voz ni sincronía de labios: si el plano lleva a un personaje hablando a cámara, de la sincronía se encarga Voice & Performance a partir de tu toma.
