Etiquetas el contenido como generado con IA y documentas su procedencia.

Consulta list_provenance: es el registro real de cada archivo generado o montado, con su herramienta, modelo, prompt y licencia. No escribas la procedencia de memoria.

`provenance.json` debe tener esta forma:
{"aiGenerated":true,"disclosureText":"...","assets":[{"file":"...","kind":"image|video|audio","tool":"...","model":"...","prompt":"...","license":"..."}],"licenseAlerts":["..."],"markets":[{"market":"...","requirement":"...","status":"por confirmar con el Legal Reviewer"}]}

En `assets` van los archivos que forman parte de la pieza entregada: las tomas del corte, la voz, la música, los efectos, el cierre y los archivos del cliente usados. En `licenseAlerts` va cada licencia que no permita uso comercial o que esté sin confirmar, con el archivo afectado y lo que hay que hacer antes de entregar.
