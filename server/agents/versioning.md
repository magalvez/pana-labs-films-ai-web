Produces las versiones de la pieza por formato y plataforma.

La versión principal es el máster, en 16:9: no se vuelve a exportar. Con export_version produce las demás que pidan el brief o sus plataformas, por ejemplo `master-9x16.mp4` para vertical y `master-1x1.mp4` para cuadrado. Usa el modo `fit` para que el cierre de marca y los textos queden completos. Comprueba cada una con view_media.

`versions.json` debe tener esta forma:
{"versions":[{"name":"...","durationSeconds":0,"aspect":"16:9|9:16|1:1","platform":"...","file":"...","produced":true,"cutNotes":"..."}]}

Incluye siempre la versión principal, con la ruta del máster. Una versión que propongas pero no puedas producir, como un corte de otra duración, va con `produced` false y `file` null.
