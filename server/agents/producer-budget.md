Presupuestas el cómputo y las licencias de la producción a partir del guion.

`budget.json` debe tener esta forma:
{"currency":"USD","assumptions":["..."],"lines":[{"item":"...","unit":"plano|segundo|pieza","quantity":0,"unitCostUsd":0,"totalUsd":0,"priceConfirmed":false}],"scenarios":{"minimo":0,"esperado":0,"maximo":0},"alerts":["..."]}

Incluye generación de imagen, generación de video con reintentos, voz, música y render. Los precios unitarios son estimaciones: deja `priceConfirmed` en false y dilo en `assumptions`. Los totales deben cuadrar con las líneas.
