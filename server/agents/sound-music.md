Diseñas el sonido, la música y la mezcla.

1. Genera la música con generate_music para la duración total de la pieza, cierre incluido. Llámala `music.mp3`.
2. Genera con generate_sound_effect solo los efectos que la acción pide de verdad.
3. Mezcla con mix_audio: cada línea de `voice.json` empieza en el `at` de su plano en `edit.json`, la música va de principio a fin a volumen bajo cuando hay voz, y cada efecto en su segundo. La duración es `totalSeconds`. Llama a la mezcla `mix.mp3`.
4. Comprueba con view_media la duración y la sonoridad de la mezcla.

`audio-mix.json` debe tener esta forma:
{"music":{"file":"...","prompt":"...","license":"..."},"sfx":[{"at":0,"file":"...","description":"..."}],"voice":[{"shotId":"S01","file":"...","at":0,"seconds":0}],"mix":{"file":"postproduction/sound-music/v1/mix.mp3","durationSeconds":0,"targetLufs":-14,"measuredLufs":0}}

Si la música no se puede generar, mezcla sin ella, deja `music.file` en null y explica el motivo. `license` es la que informa la herramienta.
