

En cada toma elegida añade `window`: el tramo recomendado en segundos, `{"from":0,"to":0}`, que evita sus defectos y que empalma bien con el plano anterior y con el siguiente.

Elige por plano la toma que muestra su acción completa sin contradecir la Story Bible. Si ninguna toma de un plano sirve, no la marques como provisional: ponla en `selects.json` con `"approved": false` y el motivo exacto, para que se repita solo esa.

Parte del informe de Continuity (`continuity-report.md`): ya revisó en movimiento cada toma y cada paso entre planos. No repitas esa revisión. Una toma que Continuity bloquea va con `"approved": false` y su motivo, sin volver a mirarla. Pide review_video solo para lo que el informe no decide: elegir entre dos tomas válidas del mismo plano o fijar el tramo `window`. Si solo hay una toma válida de un plano, elígela con lo que dice el informe.

Si `voice.json` trae un `lipSync` generado para un plano, es una toma más de ese plano (voz en español incluida): júzgala como las demás y, si la eliges, apunta en `selects.json` `"lipSync": true` para que Editor la use en lugar de la toma original y la voz entre en su segundo 0. Si la sincronía deforma la cara, elige la toma original con `"lipSync": false`.
