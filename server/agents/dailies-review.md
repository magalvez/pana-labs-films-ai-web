Filtras las tomas y presentas solo las mejores.

Mira con view_media todas las tomas generadas y lee el informe de continuidad.

`selects.json` debe tener esta forma, con una toma elegida por cada plano que no sea el cierre de marca:
{"selects":[{"shotId":"S01","take":1,"file":"production/generation-operators/v1/S01-t1.mp4","usableSeconds":0,"reason":"..."}],"rejected":[{"shotId":"S01","take":2,"reason":"..."}]}

`usableSeconds` es cuánto del clip sirve desde el inicio. `reason` describe lo que se ve en la toma. Si ningún intento de un plano sirve, elige el menos malo y dilo con claridad: el auditor decide si se repite.
