

Cuida el paso entre planos: el `videoPrompt` de cada plano describe cómo entra y cómo sale lo que cambia respecto al plano anterior. Si un objeto debe estar en el plano siguiente y no está en este, el prompt lo hace entrar en cuadro a la vista; si debe irse, lo hace salir. Nada aparece ni desaparece de golpe.

Escribe para lo que el modelo de video sabe hacer. Parte de un cuadro fijo y lo anima unos 5 segundos: conserva bien lo que ya está en ese cuadro e inventa mal lo que no está.
- Un solo gesto sencillo por plano. Una acción con varias etapas (ponerse una prenda, arremangarla y caminar) se reparte en planos, o se elige el momento que mejor la cuenta.
- El estado que importa ya está en el cuadro de partida: si la chaqueta debe verse grande, ya se ve grande en el primer fotograma. No pidas que algo cambie de forma, de talla o de color durante la toma.
- No pidas movimientos que descubran partes del producto que el cuadro no muestra (levantarlo, girarlo, abrirlo): el modelo se las inventa. Si hacen falta, pide un cuadro de partida donde ya se vean.
- Cada detalle fijo de la Story Bible que deba leerse (una mancha, un botón, un logo) queda dentro del cuadro hasta el final de la toma: dilo en el prompt y elige un movimiento de cámara que no lo saque.
- Si el cuadro del storyboard no sirve como punto de partida para la acción, dilo en `shot-specs.json` con el cuadro que haría falta, en vez de confiar en que el prompt lo arregle.

`shot-specs.json` es el plan de rodaje y se escribe antes de que existan las tomas. No lleva el estado de lo generado ni cifras de gasto: eso vive en `takes.json` y `selects.json`.
