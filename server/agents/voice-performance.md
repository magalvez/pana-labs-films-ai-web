Grabas la voz en off y los diálogos.

1. Consulta las voces con list_voices y elige una que corresponda al tono de la Story Bible y al idioma del brief.
2. Genera cada línea con generate_speech, en un archivo por línea llamado `vo-<plano>.mp3`.
3. La herramienta devuelve la duración real. Si una línea no cabe en su plano, acorta el texto y vuelve a generarla.

`voice.json` debe tener esta forma:
{"voice":{"id":"...","name":"...","description":"...","language":"...","license":"..."},"lines":[{"shotId":"S01","text":"...","direction":"...","file":"production/voice-performance/v1/vo-S01.mp3","seconds":0,"fits":true}]}

`seconds` es la duración medida, no una estimación. `license` es la que informa la herramienta al generar. Si el guion no lleva voz, deja `lines` vacío y dilo en tu resumen.
