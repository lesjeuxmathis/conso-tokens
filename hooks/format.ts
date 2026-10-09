import type { ConsoDevise } from '../types'

const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']

const pad = (n: number) => String(n).padStart(2, '0')

export const comma = (x: number, digits: number) => x.toFixed(digits).replace('.', ',')

/** 1 234 567 */
export const exact = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/** 987, 12,3 k, 4,56 M */
export function tokens(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${comma(n / 1e3, n < 1e4 ? 2 : n < 1e5 ? 1 : 0)} k`
  if (n < 1e9) return `${comma(n / 1e6, n < 1e7 ? 2 : 1)} M`
  return `${comma(n / 1e9, 2)} Md`
}

const dollars = (usd: number) => `${comma(usd, usd < 1 ? 3 : 2)} $`
const euros = (eur: number) => `${comma(eur, eur < 1 ? 3 : 2)} €`

/** Un montant en dollars, converti au taux de la BCE quand la devise le demande. */
export function money(usd: number, devise: ConsoDevise, usdPerEur?: number): string {
  if (devise === 'usd' || !usdPerEur) return dollars(usd)
  if (devise === 'eur') return euros(usd / usdPerEur)
  return `${dollars(usd)} (≈ ${euros(usd / usdPerEur)})`
}

/** 2 h 05, 3 j 4 h, 12 min */
export function duration(ms: number): string {
  if (ms < 60_000) return 'moins d’1 min'
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return h > 0 ? `${d} j ${h} h` : `${d} j`
  if (h > 0) return `${h} h ${pad(m)}`
  return `${m} min`
}

/** 18:30 le jour même, sinon « mar. 14/10 09:00 ». */
export function clock(ts: number, now: number): string {
  const d = new Date(ts)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const isToday = new Date(now).toDateString() === d.toDateString()

  return isToday ? hm : `${DAYS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`
}

/** 08/10 17:50 */
export function stamp(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ago(ms: number): string {
  if (ms < 60_000) return `il y a ${Math.max(1, Math.round(ms / 1000))} s`
  return `il y a ${duration(ms)}`
}

const KIND_LABELS: Record<string, string> = {
  five_hour: 'Fenêtre 5 h',
  seven_day: 'Semaine (7 j)',
  seven_day_opus: 'Semaine Opus',
  seven_day_sonnet: 'Semaine Sonnet',
  spend_limit: 'Crédit / plafond de dépense',
}

const KIND_SHORT: Record<string, string> = {
  five_hour: '5 h',
  seven_day: '7 j',
  seven_day_opus: '7 j Opus',
  seven_day_sonnet: '7 j Sonnet',
  spend_limit: 'crédit',
}

export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind.replace(/_/g, ' ')
export const kindShort = (kind: string) => KIND_SHORT[kind] ?? kind.replace(/_/g, ' ')

/** claude-opus-5-5 → opus-5-5 ; le palier « |long » ne sert qu'au prix et n'est pas affiché. */
export const modelLabel = (key: string) => (key.split('|')[0] ?? key).replace(/^claude-/, '')

export function bar(percent: number, width: number): string {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(full) + '░'.repeat(width - full)
}

export const barColor = (percent: number) => (percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green')
