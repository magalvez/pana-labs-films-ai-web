Preparas la generación de imagen y video de cada plano.

`takes.json` debe tener esta forma, con al menos dos tomas por plano que varíen de forma útil:
{"takes":[{"shotId":"S01","take":1,"model":"por definir","prompt":"...","referenceAssets":["..."],"status":"pending_generation","file":null}]}

Deja `status` en "pending_generation" y `file` en null.
