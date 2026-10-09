import type { ConsoModelTotals, ConsoPrice, ConsoRates, ConsoTotals } from '../types'

/** La page de prix d'Anthropic, en Markdown (la source que la doc officielle désigne). */
export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'

/** Les taux de référence quotidiens de la Banque centrale européenne. */
export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

/** Au-delà, un prompt relève du tarif « long » quand le modèle en a un. */
export const LONG_PROMPT = 100_000

const cellsOf = (line: string) => line.split('|').slice(1, -1).map(cell => cell.trim())

const plain = (cell: string) =>
  cell
    .replace(/<sup>.*?<\/sup>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()

function dollarsOf(cell: string | undefined): number | undefined {
  const match = /\$\s*(\d[\d,]*(?:\.\d+)?)/.exec(cell ?? '')
  return match ? Number(match[1]!.replace(/,/g, '')) : undefined
}

/** « Claude Opus 5.5 (…) » → claude-opus-5-5 */
export function modelId(name: string): string {
  return name
    .replace(/\(.*?\)/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Lit le tableau « Model pricing » de la page officielle. Les colonnes sont
 * retrouvées par leur titre, pas par leur position ; une page qui ne contient
 * plus ce tableau donne un objet vide.
 */
export function parsePricing(md: string): Record<string, ConsoPrice> {
  const lines = md.split(/\r?\n/)
  const head = lines.findIndex(
    line => line.startsWith('|') && /base input/i.test(line) && /output/i.test(line),
  )
  if (head < 0) return {}

  const titles = cellsOf(lines[head]!).map(title => title.toLowerCase())
  const column = (re: RegExp) => titles.findIndex(title => re.test(title))
  const at = {
    input: column(/base input/),
    write5m: column(/5m cache write/),
    write1h: column(/1h cache write/),
    read: column(/cache hit/),
    output: column(/^output/),
  }
  if (Object.values(at).some(index => index < 0)) return {}

  const models: Record<string, ConsoPrice> = {}
  const longs: Array<{ id: string; rates: ConsoRates; above: number }> = []

  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith('|')) break
    const row = cellsOf(line)
    const name = plain(row[0] ?? '')
    if (!/^claude\b/i.test(name)) continue

    const values = {
      input: dollarsOf(row[at.input]),
      write5m: dollarsOf(row[at.write5m]),
      write1h: dollarsOf(row[at.write1h]),
      read: dollarsOf(row[at.read]),
      output: dollarsOf(row[at.output]),
    }
    if (Object.values(values).some(value => value === undefined)) continue
    const rates = values as ConsoRates
    const id = modelId(name)
    const over = /over\s+([\d,]+)\s+tokens/i.exec(name)

    if (over) {
      longs.push({ id, rates, above: Number(over[1]!.replace(/,/g, '')) })
    } else if (!models[id]) {
      models[id] = { name: name.replace(/\(.*?\)/g, '').trim(), ...rates }
    }
  }

  for (const { id, rates, above } of longs) {
    const base = models[id]
    if (base) models[id] = { ...base, long: rates, longAbove: above }
  }

  return models
}

/** Le taux USD du fichier quotidien de la BCE : combien de dollars vaut 1 €. */
export function parseEcb(xml: string): { usdPerEur: number; date: string } | undefined {
  const rate = /currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml)
  if (!rate) return undefined
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)

  return { usdPerEur: Number(rate[1]), date: date?.[1] ?? '' }
}

/**
 * Le tarif d'un modèle tel que l'API le nomme : claude-opus-5-5, une version
 * datée (claude-haiku-4-5-20251001), un suffixe [1m], un préfixe de cloud.
 */
export function priceFor(model: string, table: Record<string, ConsoPrice>): ConsoPrice | undefined {
  let id = model.toLowerCase().replace(/\[.*\]$/, '').replace('@', '-')
  const start = id.indexOf('claude-')
  if (start > 0) id = id.slice(start)
  if (table[id]) return table[id]

  let best: string | undefined
  for (const key of Object.keys(table)) {
    const isVersionOf = id.startsWith(key) && /^(-\d{8}(-v\d+(:\d+)?)?)?$/.test(id.slice(key.length))
    if (isVersionOf && (!best || key.length > best.length)) best = key
  }

  return best ? table[best] : undefined
}

export const emptyTotals = (): ConsoModelTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  write5m: 0,
  write1h: 0,
  writeUnknown: 0,
  requests: 0,
})

export const addTotals = (a: ConsoModelTotals, b: ConsoModelTotals): ConsoModelTotals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  write5m: a.write5m + b.write5m,
  write1h: a.write1h + b.write1h,
  writeUnknown: a.writeUnknown + b.writeUnknown,
  requests: a.requests + b.requests,
})

export const tokensOf = (t: ConsoModelTotals) =>
  t.input + t.output + t.cacheRead + t.write5m + t.write1h + t.writeUnknown

/** Clé de cumul : le modèle, suivi de « |long » pour un prompt de plus de 100 000 tokens. */
export function bucketOf(model: string, t: ConsoModelTotals): string {
  const prompt = t.input + t.cacheRead + t.write5m + t.write1h + t.writeUnknown
  return prompt > LONG_PROMPT ? `${model}|long` : model
}

/**
 * Le prix d'un cumul au tarif officiel. Les écritures de cache dont on ignore
 * la durée sont réparties selon `share1h`, la part à 1 h observée dans le journal.
 */
export function costOf(
  key: string,
  t: ConsoModelTotals,
  table: Record<string, ConsoPrice>,
  share1h: number,
): number | undefined {
  const [model = key, tier] = key.split('|')
  const price = priceFor(model, table)
  if (!price) return undefined
  const rates = tier === 'long' && price.long ? price.long : price
  const write5m = t.write5m + t.writeUnknown * (1 - share1h)
  const write1h = t.write1h + t.writeUnknown * share1h

  return (
    (t.input * rates.input +
      t.output * rates.output +
      t.cacheRead * rates.read +
      write5m * rates.write5m +
      write1h * rates.write1h) /
    1e6
  )
}

/** Le prix de tous les cumuls, et les modèles absents de la grille. */
export function totalCost(
  totals: ConsoTotals,
  table: Record<string, ConsoPrice>,
  share1h: number,
): { usd: number; unknown: string[] } {
  let usd = 0
  const unknown: string[] = []
  for (const [key, t] of Object.entries(totals)) {
    const cost = costOf(key, t, table, share1h)
    if (cost === undefined) unknown.push(key.split('|')[0]!)
    else usd += cost
  }

  return { usd, unknown: [...new Set(unknown)] }
}
