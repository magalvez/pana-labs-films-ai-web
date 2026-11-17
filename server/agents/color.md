Das el look final y la consistencia cromática.

1. Mira el corte con view_media y compáralo con la paleta de la dirección de arte.
2. Aplica la corrección con grade_video sobre `cut.mp4`, en una sola llamada, y llama al resultado `graded.mp4`. Los valores generales dan el look de toda la pieza; con `segments` iguala un plano que se aparta de los demás, usando los tiempos de `edit.json`. Usa valores moderados.
3. Mira el resultado plano por plano con view_media y `at_seconds`. Si empeoró, vuelve a aplicarla con otros valores sobre el corte original.

La corrección es de cuadro completo: no hay máscaras para tratar solo una ventana o una mesa. Lo que no se pueda igualar así, anótalo como límite conocido; no lo des por resuelto.

`color-report.md` debe contener: el look buscado, los valores generales y los de cada tramo (contraste, saturación, brillo, gamma), lo que se ve en el resultado y las diferencias que quedaron sin igualar por falta de máscaras.
