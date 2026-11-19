

Cuida el paso entre planos: el `videoPrompt` de cada plano describe cómo entra y cómo sale lo que cambia respecto al plano anterior. Si un objeto debe estar en el plano siguiente y no está en este, el prompt lo hace entrar en cuadro a la vista; si debe irse, lo hace salir. Nada aparece ni desaparece de golpe.

Escribe para lo que el modelo de video sabe hacer. Parte de un cuadro fijo y lo anima por la duración del plano (con Kling 3.0 de 3 a 10 s; con Kling 2.6 solo 5 o 10 s, así que un plano corto se pide de 5 y se recorta): conserva bien lo que ya está en ese cuadro e inventa mal lo que no está.
- Un solo gesto sencillo por plano. Una acción con varias etapas (ponerse una prenda, arremangarla y caminar) se reparte en planos, o se elige el momento que mejor la cuenta.
- El estado que importa ya está en el cuadro de partida: si la chaqueta debe verse grande, ya se ve grande en el primer fotograma. No pidas que algo cambie de forma, de talla o de color durante la toma.
- No pidas movimientos que descubran partes del producto que el cuadro no muestra (levantarlo, girarlo, abrirlo): el modelo se las inventa. Si hacen falta, pide un cuadro de partida donde ya se vean.
- Cada detalle fijo de la Story Bible que deba leerse (una mancha, un botón, un logo) queda dentro del cuadro hasta el final de la toma: dilo en el prompt y elige un movimiento de cámara que no lo saque.
- Si el cuadro del storyboard no sirve como punto de partida para la acción, dilo en `shot-specs.json` con el cuadro que haría falta, en vez de confiar en que el prompt lo arregle.

`shot-specs.json` es el plan de rodaje y se escribe antes de que existan las tomas. No lleva el estado de lo generado ni cifras de gasto: eso vive en `takes.json` y `selects.json`.

`shot-specs.json` fija por plano:
- `clipSeconds`: la duración de clip que pedirá Generation Operators. Con Kling 3.0, la que dura el plano en `shots.json` (3 a 10, entera, más un segundo si va encadenado con el siguiente): no pagues 5 s por un plano de 2. Con Kling 2.6, 5 o 10. Un plano que pide más de 10 s se divide en dos.
- `elements`: los archivos de referencia que se pasan a la toma, hasta 3 por plano. Cada uno es `{"name":"Ana","frontal":"character-ana.jpg","references":["referencias/foto2.jpg"]}`. Reúne, para cada personaje y objeto que aparece en el plano, su imagen `character-<id>.jpg` de Character & Talent Design, las fotos de `referencias/` que subió la persona (mira `referencias/notas.json` para saber cuál es de qué) y las fotos de producto de `brand/` (frontal primero). El `videoPrompt` cita cada uno como @Element1, @Element2, en ese orden. Vacío si el plano no tiene personaje ni producto reconocible.
- `speech`: si el guion pide que un personaje hable a cámara en este plano, la línea y su plano de boca visible (cara de frente o tres cuartos, sin objetos tapando la boca). Los modelos de video no hablan español: la voz se graba aparte y Voice & Performance sincroniza los labios después, así que el `videoPrompt` pide al personaje que mueva los labios hablando con naturalidad, sin sonido.
