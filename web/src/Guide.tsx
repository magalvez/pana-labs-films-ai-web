import { useEffect, useRef, useState, type CSSProperties } from 'react'
import './guide.css'

type Go = 'studio' | 'producciones' | 'rentabilidad' | 'equipo' | 'configuracion'
type Scene = { id: string; title: string; why: string; steps: string[]; tip?: string; to?: [Go, string]; admin?: boolean }

// La guía completa. Cada escena: para qué sirve, los pasos en orden y, si hace falta, un consejo.
// Los nombres entre «» son los de los botones tal como se ven en pantalla.
const SCENES: Scene[] = [
  {
    id: 'estudio', title: 'Conoce el estudio', why: 'La oficina es el tablero de control: ahí ves quién trabaja y en qué va cada comercial.',
    steps: [
      'Arriba eliges la producción en la lista «Producción». Sin ninguna elegida, el equipo descansa en la oficina y la cafetería.',
      'Cada personaje es un agente. Haz clic en uno para ver qué hizo, sus entregables y su registro.',
      'La franja de etapas muestra por dónde va el comercial; el letrero indica si está en el aire, esperándote o entregado.',
      'A la derecha están el estado, el modo y el presupuesto gastado frente al tope.',
    ],
    tip: 'Con «Ver repetición» revives la producción completa en cámara rápida. Sirve para mostrársela a un cliente.',
    to: ['studio', 'Ir al estudio'],
  },
  {
    id: 'crear', title: 'Crea un proyecto', why: 'Cuanto más claro llegue el encargo, menos repeticiones y menos gasto.',
    steps: [
      'Pulsa «Nuevo proyecto». El equipo corre a sus puestos.',
      'Escribe el nombre y el brief: qué se vende, a quién, duración, tono y qué no puede faltar.',
      'Pon el tope de presupuesto en dólares. El estudio nunca gasta por encima de ese número.',
      'Añade la marca: logos y fotos reales del producto. Los agentes los usan tal cual, no los inventan.',
      'Sube fotos de referencia (hasta 10) y di qué deben tomar de ellas: la luz, el lugar, el estilo.',
      'Decide si quieres explorar el look antes de producir, y pulsa «Crear proyecto».',
    ],
    tip: '¿Un comercial parecido a otro? Elige ese proyecto como plantilla y hereda sus referencias.',
  },
  {
    id: 'explorar', title: 'Explora el look (opcional)', why: 'Eliges cómo se verá el comercial con imágenes fijas, antes de gastar en video.',
    steps: [
      'En la sala de exploración pide una propuesta: el estudio lee el brief y arma tableros (protagonista, locación, look).',
      'Ajusta el texto de cada tablero si quieres y genera opciones. Cada imagen muestra su costo antes de crearla.',
      'Marca las que te gustan. Las elegidas se vuelven la referencia que todos los agentes deben respetar.',
      'Comparte el moodboard con el cliente por enlace; puede aprobar o comentar sin tener cuenta.',
      'Cuando el look esté decidido, inicia la producción.',
    ],
    tip: 'Nada del equipo trabaja mientras exploras: solo pagas las imágenes que generes.',
  },
  {
    id: 'etapas', title: 'Las cinco etapas', why: 'Todo comercial recorre el mismo camino. Saberlo te dice qué esperar en cada aprobación.',
    steps: [
      'Strategy: brief, investigación, historia y concepto. Apruebas el concepto y el guion.',
      'Pre-production: dirección de arte, personajes, locaciones, storyboard y presupuesto. Apruebas el storyboard y el costo estimado.',
      'Production: se generan las tomas de video y la voz. Apruebas las tomas finales.',
      'Post-production: montaje, color, sonido, música y títulos. Apruebas el corte final.',
      'Delivery: versiones por formato, cumplimiento y entrega. Apruebas y queda entregado.',
    ],
    tip: 'Cada etapa tiene un auditor que revisa antes que tú. Si algo falla, devuelve el trabajo solo al agente responsable.',
  },
  {
    id: 'decidir', title: 'Aprueba o devuelve', why: 'Es tu momento de dirigir: nada avanza a la siguiente etapa sin tu visto bueno.',
    steps: [
      'Cuando el estado diga «Espera tu decisión», abre lo que entregó cada agente y lee «Qué dijo el auditor».',
      'Si está bien, pulsa «Aprobar etapa».',
      'Si no, pulsa «Devolver con comentario» y escribe qué hay que corregir, concreto: "el producto debe verse en el plano 3".',
      'Marca quién lo repite. Sin marcar a nadie, se rehace toda la etapa; marcando, solo esos agentes.',
      '¿Una imagen lo explica mejor? Sube una foto de referencia ahí mismo y di qué deben tomar de ella.',
    ],
    tip: 'Devolver a un solo agente es más rápido y barato que rehacer la etapa completa.',
  },
  {
    id: 'presupuesto', title: 'Controla el gasto', why: 'El tope es tu seguro: el estudio se detiene antes de pasarse.',
    steps: [
      'El presupuesto se actualiza solo con cada cosa que se genera.',
      'Si se alcanza el tope, el proyecto se pausa y te avisa. No se pierde nada.',
      'Pulsa «+ Tope», escribe el nuevo valor y el trabajo sigue donde quedó.',
      'Puedes pausar o cancelar un proyecto en cualquier momento.',
    ],
    tip: 'El modo simulación recorre todo el proceso con archivos de muestra y no gasta. Úsalo para practicar.',
  },
  {
    id: 'cliente', title: 'Muéstralo al cliente', why: 'El cliente ve la pieza y opina desde un enlace, sin cuenta y sin ver costos.',
    steps: [
      'En Producciones, abre la producción y crea un enlace para el cliente. Tú eliges cuántos días dura.',
      'Envíale el enlace. Verá el video, podrá aprobar o dejar comentarios.',
      'Su opinión te llega al estudio bajo «El cliente opinó» (y a Telegram si lo enlazaste).',
      'Pulsa «Usar como indicación» para convertir su comentario en una corrección, o «Descartar».',
    ],
    tip: 'El comentario del cliente pasa primero por ti: nunca cambia nada por sí solo.',
    to: ['producciones', 'Ir a Producciones'], admin: true,
  },
  {
    id: 'mejoras', title: 'Pide mejoras después de entregar', why: 'Un comercial entregado no está cerrado: puedes ajustarlo cuando quieras.',
    steps: [
      'Abre la producción entregada y pulsa «Pedir una mejora».',
      'Elige la etapa donde está el cambio y descríbelo.',
      'Pon cuánto se puede gastar en esa mejora. Ese valor se suma al tope.',
      'El auditor de la etapa reparte el trabajo. Se rehace esa etapa y las siguientes; lo anterior no se toca.',
      'Vuelves a aprobar cada etapa rehecha, igual que la primera vez.',
    ],
    tip: 'Pide el cambio en la etapa más tardía posible: un ajuste de música va en Post-production, no en Strategy.',
  },
  {
    id: 'telegram', title: 'Recibe avisos en Telegram', why: 'Te enteras al momento y decides desde el celular, sin abrir el estudio.',
    steps: [
      'Entra a Configuración y pulsa «Enlazar mi Telegram».',
      'Escanea el código QR con la cámara del celular y pulsa «Iniciar» en Telegram.',
      'La pantalla cambia sola a «Tu Telegram está enlazado».',
      'Te llega un aviso cuando una etapa te espera, se alcanza el tope, algo se detiene, se entrega o el cliente opina.',
      'Desde el chat pulsa «Aprobar etapa», o «Devolver» y escribe en un mensaje qué corregir.',
    ],
    tip: 'El enlace es personal: cada persona del equipo conecta su propio Telegram.',
    to: ['configuracion', 'Ir a Configuración'],
  },
  {
    id: 'rentabilidad', title: 'Mide la ganancia', why: 'Sabes cuánto costó, en cuánto se vendió y cuánto quedó en cada producción.',
    steps: [
      'En Producciones, abre una producción y registra en cuánto se vendió, en dólares o pesos colombianos.',
      'Añade los gastos adicionales: locutor, licencias, horas de alguien del equipo.',
      'Abre Rentabilidad: ves vendido, costo, ganancia y margen de cada producción.',
      'Filtra por mes, fechas, cliente o estado. Con «Exportar CSV» lo llevas a una hoja de cálculo.',
    ],
    tip: 'El costo de la inteligencia artificial se suma solo; tú solo registras lo que pasa fuera del estudio.',
    to: ['rentabilidad', 'Ir a Rentabilidad'], admin: true,
  },
  {
    id: 'equipo', title: 'Suma a tu equipo', why: 'Cada persona entra con su cuenta y ve solo lo que le corresponde.',
    steps: [
      'En Equipo escribe el correo de la persona y elige su rol.',
      'Administrador: ve todo, incluidos costos, rentabilidad y configuración.',
      'Miembro: trabaja en el estudio, aprueba etapas y recibe sus avisos.',
      'Pulsa «Crear cuenta» y entrégale la contraseña en persona. Se muestra una sola vez.',
    ],
    to: ['equipo', 'Ir a Equipo'], admin: true,
  },
  {
    id: 'configuracion', title: 'Ajusta el estudio', why: 'Aquí decides cuánta supervisión, velocidad y calidad quieres.',
    steps: [
      'Revisión humana: encendida, cada etapa espera tu aprobación; apagada, avanza sola si el auditor aprueba.',
      'Simulación: los proyectos nuevos no gastan. Cada proyecto conserva el modo con el que nació.',
      'Agentes en paralelo: termina antes, porque los agentes independientes trabajan a la vez.',
      'Modelos: elige el de imagen, el de video y el de cada agente. Mejor modelo, mejor resultado y mayor costo.',
      'Corrida de regresión: un comercial fijo para comparar costo y tiempo después de cambiar algo.',
    ],
    tip: 'Cambia una cosa a la vez y corre la regresión: así sabes qué ajuste mejoró o encareció.',
    to: ['configuracion', 'Ir a Configuración'], admin: true,
  },
]

const SEEN = 'pana.guia.vistas'
const readSeen = (): string[] => { try { return JSON.parse(localStorage.getItem(SEEN) ?? '[]') } catch { return [] } }

export function Guide({ admin, go }: { admin: boolean; go: (view: Go) => void }) {
  const scenes = SCENES.filter((s) => admin || !s.admin)
  const [seen, setSeen] = useState<string[]>(readSeen)
  const [active, setActive] = useState(scenes[0].id)
  const [shown, setShown] = useState<string[]>([])
  const root = useRef<HTMLDivElement>(null)

  // Cada escena entra al llegar a la vista, y la tira de película marca por cuál vas.
  useEffect(() => {
    const cards = [...(root.current?.querySelectorAll<HTMLElement>('.gd-scene') ?? [])]
    if (!('IntersectionObserver' in window)) return setShown(scenes.map((s) => s.id))
    const enter = new IntersectionObserver((hits) => setShown((old) => [...new Set([...old, ...hits.filter((h) => h.isIntersecting).map((h) => (h.target as HTMLElement).dataset.id!)])]), { threshold: 0.12 })
    const here = new IntersectionObserver((hits) => { const hit = hits.find((h) => h.isIntersecting); if (hit) setActive((hit.target as HTMLElement).dataset.id!) }, { rootMargin: '-35% 0px -55% 0px' })
    for (const c of cards) { enter.observe(c); here.observe(c) }
    return () => { enter.disconnect(); here.disconnect() }
  }, [admin])

  const mark = (id: string) => setSeen((old) => {
    const next = old.includes(id) ? old.filter((x) => x !== id) : [...old, id]
    try { localStorage.setItem(SEEN, JSON.stringify(next)) } catch { /* sin almacenamiento, vale solo para esta visita */ }
    return next
  })
  const done = scenes.filter((s) => seen.includes(s.id)).length
  const all = done === scenes.length
  const jump = (id: string) => document.getElementById(`guia-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // El foco de luz sigue al puntero sobre la portada.
  const light = (e: React.PointerEvent<HTMLElement>) => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`); e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`) }

  return (
    <div className="guide" ref={root}>
      <header className="gd-hero" onPointerMove={light}>
        <div className="gd-clap" aria-hidden="true"><i /><b>GUÍA · TOMA 1</b></div>
        <div>
          <p className="gd-kicker">Manual de rodaje</p>
          <h2>Aprende a usar el estudio en {scenes.length} escenas</h2>
          <p className="gd-lead">Sin tecnicismos. Cada escena dice para qué sirve y qué hacer, paso a paso. Léelas en orden o salta a la que necesites.</p>
          <p><button className="primary" onClick={() => jump(scenes.find((s) => !seen.includes(s.id))?.id ?? scenes[0].id)}>{done && !all ? 'Seguir donde quedé' : '¡Acción!'}</button></p>
        </div>
      </header>

      <nav className="gd-strip" aria-label="Escenas de la guía">
        <div className="gd-reel" role="progressbar" aria-label="Escenas vistas" aria-valuemin={0} aria-valuemax={scenes.length} aria-valuenow={done}><i style={{ width: `${(done / scenes.length) * 100}%` }} /></div>
        <ol>
          {scenes.map((s, n) => (
            <li key={s.id}><button aria-current={active === s.id ? 'step' : undefined} className={seen.includes(s.id) ? 'seen' : undefined} onClick={() => jump(s.id)}><span>{String(n + 1).padStart(2, '0')}</span>{s.title}{seen.includes(s.id) && <em> · vista</em>}</button></li>
          ))}
        </ol>
        <p className="gd-count" aria-live="polite">{done} de {scenes.length} escenas vistas</p>
      </nav>

      {scenes.map((s, n) => (
        <section key={s.id} id={`guia-${s.id}`} data-id={s.id} className={`gd-scene${shown.includes(s.id) ? ' in' : ''}${seen.includes(s.id) ? ' seen' : ''}`} aria-labelledby={`guia-t-${s.id}`}>
          <p className="gd-num" aria-hidden="true">{String(n + 1).padStart(2, '0')}</p>
          <div className="gd-card">
            <p className="gd-slate">Escena {n + 1}{s.admin ? ' · Solo administradores' : ''}</p>
            <h3 id={`guia-t-${s.id}`}>{s.title}</h3>
            <p className="gd-why">{s.why}</p>
            <ol className="gd-steps">{s.steps.map((step, i) => <li key={i} style={{ '--i': i } as CSSProperties}>{step}</li>)}</ol>
            {s.tip && <p className="gd-tip"><strong>Consejo.</strong> {s.tip}</p>}
            <p className="gd-actions">
              <label className="gd-check"><input type="checkbox" checked={seen.includes(s.id)} onChange={() => mark(s.id)} /> Ya la entendí</label>
              {s.to && <button onClick={() => go(s.to![0])}>{s.to[1]}</button>}
            </p>
            {seen.includes(s.id) && <p className="gd-stamp" aria-hidden="true">Toma buena</p>}
          </div>
        </section>
      ))}

      <footer className={`gd-wrap${all ? ' all' : ''}`}>
        {all && <div className="confetti" aria-hidden="true">{Array.from({ length: 24 }, (_, n) => <i key={n} style={{ '--n': n } as CSSProperties} />)}</div>}
        <h2>{all ? '¡Corten! Ya sabes usar el estudio' : 'Marca cada escena cuando la entiendas'}</h2>
        <p>{all ? 'Vuelve cuando quieras: la guía sigue aquí, arriba, en «Guía».' : `Te faltan ${scenes.length - done}. La guía recuerda por dónde vas en este navegador.`}</p>
        <p><button className="primary" onClick={() => go('studio')}>Ir al estudio</button></p>
      </footer>
    </div>
  )
}
