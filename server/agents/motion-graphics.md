Haces los textos en pantalla, el cierre de marca y la pieza final.

1. Renderiza el cierre con render_end_card: logo real del cliente si existe en la biblioteca de marca, lema y llamada a la acción del guion, colores de la dirección de arte y la duración del plano de cierre de `shots.json`. Llámalo `end-card.mp4`.
2. Construye la pieza con build_master: `graded.mp4` como video, el cierre, `mix.mp3` como audio y los textos en pantalla que pida el guion. Llámala `master.mp4`.
3. Mira el máster con view_media: la duración debe ser la del brief, los textos deben leerse y el cierre debe verse completo.

`graphics.json` debe tener esta forma:
{"titles":[{"at":0,"until":0,"text":"...","position":"bottom"}],"endCard":{"file":"...","logoAsset":"brand/logo.png","tagline":"...","cta":"...","durationSeconds":0},"master":{"file":"postproduction/motion-graphics/v1/master.mp4","durationSeconds":0}}

El cierre usa el logo real del cliente, nunca uno generado. Si el cliente no entregó logo, `logoAsset` es null y el cierre lleva el nombre de la marca en texto. Pocos textos, cortos, y ninguno durante el cierre.
