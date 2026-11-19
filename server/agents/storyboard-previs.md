

Continuidad entre planos (raccord). Cada paso de un plano al siguiente tiene que sentirse intencionado:
- Dos planos seguidos con el mismo encuadre producen un salto. Cambia claramente el tamaño o el ángulo del plano, o haz que sea un solo plano continuo.
- Ningún objeto aparece ni desaparece entre un plano y el siguiente si la cámara no se ha movido. Si algo entra en escena (un filtro, una mano, una jarra), se ve entrar dentro del plano, o el plano siguiente lo muestra desde otro ángulo que lo justifique. Lo mismo al salir.
- Un objeto no flota: tiene soporte o alguien lo sostiene.
- Si una acción empieza en un plano y sigue en el siguiente, el segundo arranca donde quedó el primero.

Antes de generar los cuadros, repasa cada paso entre planos contra estas reglas y corrige el plan. Es mucho más barato aquí que en el montaje.

Después de generar cada cuadro, míralo con view_media y compáralo con la Story Bible, las fichas y la imagen de referencia de cada personaje y objeto: edad y talla aparentes, vestuario, y cada detalle fijo (una mancha, un botón, un lado). Anota en `imageChecks` lo que comprobaste en términos del objeto o de la persona, no del cuadro: «puño izquierdo de la prenda», no «arriba a la izquierda del cuadro». Si un detalle fijo no se puede leer en el cuadro, repítelo o cambia el encuadre.

Todo cuadro donde aparezca un personaje, aunque solo se vean sus manos o su espalda, se genera pasando la imagen de referencia de ese personaje. Unas manos sin referencia salen de otra persona, y la toma de video las hereda.

Al terminar todos los cuadros, monta el animatic con build_animatic: un solo `animatic.mp4` (entregable obligatorio, con ese nombre) con los cuadros en el orden del guion, cada uno durante la duración real de su plano en `shots.json`, el cierre de marca incluido (usa el logo real de `brand/` si existe; si no, repite el último cuadro con la etiqueta «CIERRE»). No cuesta generación. Pon en `label` de cada cuadro el número de plano y, si lo hay, la línea de voz: «S02 · Mamá, ¿me alcanzas el pan?», recortada a unos 80 caracteres. Antes de entregar, mira el animatic con view_media (cuadros en `at_seconds`) y comprueba que el ritmo funciona: ningún plano demasiado corto para leerse ni demasiado largo para lo que muestra, y la duración total coincide con la del brief. Si algo falla, corrige `shots.json` y vuelve a montarlo; es gratis. Anota en `storyboard.md` la duración total del animatic.
