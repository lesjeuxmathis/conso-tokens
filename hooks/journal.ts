import type { ConsoModelTotals, ConsoTotals } from '../types'
import { addTotals, bucketOf, emptyTotals } from './prix'

/** Une réponse du modèle telle que le journal de la session l'a enregistrée. */
export type JournalRecord = { id: string; model: string; usage: ConsoModelTotals; at?: string }

/** Un journal de session sur le disque. */
export type JournalFile = { id: string; path: string; folder: string; size: number; mtimeMs: number }

/** Ce qu'un journal de session donne une fois lu. */
export type SessionReport = {
  id: string
  path: string
  title?: string
  firstAt?: string
  lastAt?: string
  totals: ConsoTotals
  subagentRequests: number
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Joint des morceaux de chemin avec `sep`, sans doubler les séparateurs. */
export const joinPath = (sep: string, ...parts: string[]) =>
  parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)

/**
 * Une ligne du journal → la réponse qu'elle enregistre, ou rien. Une réponse
 * est écrite sur plusieurs lignes (une par bloc) sous le même id de message :
 * l'appelant garde la dernière.
 */
export function recordOf(line: string): JournalRecord | undefined {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return undefined
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  const message = row?.message
  const usage = message?.usage
  if (row?.type !== 'assistant' || !usage || typeof message.model !== 'string') return undefined
  if (message.model === '<synthetic>') return undefined

  const written = num(usage.cache_creation_input_tokens)
  const written1h = Math.min(written, num(usage.cache_creation?.ephemeral_1h_input_tokens))

  return {
    id: String(message.id ?? row.uuid ?? line.length),
    model: message.model,
    ...(typeof row.timestamp === 'string' ? { at: row.timestamp } : {}),
    usage: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      write5m: written - written1h,
      write1h: written1h,
      writeUnknown: 0,
      requests: 1,
    },
  }
}

/** Le titre que l'app a donné à la session, s'il est sur cette ligne. */
export function titleOf(line: string): string | undefined {
  if (!line.includes('"custom-title"')) return undefined
  try {
    const row = JSON.parse(line)
    return row?.type === 'custom-title' && typeof row.customTitle === 'string' ? row.customTitle : undefined
  } catch {
    return undefined
  }
}

/** Cumule les réponses par modèle, chaque id de message compté une fois. */
export class Ledger {
  readonly records = new Map<string, JournalRecord>()
  title?: string

  add(line: string): void {
    const record = recordOf(line)
    if (record) {
      this.records.set(record.id, record)
      return
    }
    this.title = titleOf(line) ?? this.title
  }

  totals(): ConsoTotals {
    const totals: ConsoTotals = {}
    for (const { model, usage } of this.records.values()) {
      const key = bucketOf(model, usage)
      totals[key] = addTotals(totals[key] ?? emptyTotals(), usage)
    }
    return totals
  }

  span(): { firstAt?: string; lastAt?: string } {
    const times = [...this.records.values()].flatMap(record => (record.at ? [record.at] : [])).sort()
    const firstAt = times[0]
    const lastAt = times[times.length - 1]
    return { ...(firstAt ? { firstAt } : {}), ...(lastAt ? { lastAt } : {}) }
  }
}

/** La part des écritures de cache faites à 1 h, pour répartir celles comptées en direct. */
export function share1hOf(totals: ConsoTotals): number {
  let w5 = 0
  let w1 = 0
  for (const t of Object.values(totals)) {
    w5 += t.write5m
    w1 += t.write1h
  }
  return w5 + w1 > 0 ? w1 / (w5 + w1) : 0
}
