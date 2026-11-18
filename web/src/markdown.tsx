import type { ReactNode } from 'react'

/** Negritas y cursivas dentro de una línea. Todo lo demás se muestra tal cual: nunca se interpreta como HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <em key={i}>{part.slice(1, -1)}</em>
        : part)
}

/**
 * El Markdown que escribe la memoria de producción: títulos, párrafos y listas.
 * ponytail: no cubre tablas, enlaces ni código; si la memoria los necesita, toca una librería de Markdown.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r/g, '').split('\n')
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim()
    if (!line) { i++; continue }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const Tag = heading[1].length <= 2 ? 'h2' : 'h3'
      blocks.push(<Tag key={i}>{inline(heading[2])}</Tag>)
      i++
      continue
    }
    const item = (s: string) => /^(\d+[.)]|[-*•])\s+(.*)$/.exec(s.trim())
    if (item(line)) {
      const ordered = /^\d/.test(line)
      const items: ReactNode[] = []
      for (; i < lines.length && item(lines[i]); i++) items.push(<li key={i}>{inline(item(lines[i])![2])}</li>)
      blocks.push(ordered ? <ol key={`l${i}`}>{items}</ol> : <ul key={`l${i}`}>{items}</ul>)
      continue
    }
    const paragraph: string[] = []
    for (; i < lines.length && lines[i].trim() && !/^#{1,4}\s/.test(lines[i].trim()) && !item(lines[i]); i++) paragraph.push(lines[i].trim())
    blocks.push(<p key={`p${i}`}>{inline(paragraph.join(' '))}</p>)
  }
  return <>{blocks}</>
}
