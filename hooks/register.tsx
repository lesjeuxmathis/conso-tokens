import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PluginOptions,
  Register,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
} from 'claude-code'

import type {
  ConsoChange,
  ConsoDevise,
  ConsoEstimate,
  ConsoModelTotals,
  ConsoSnapshot,
  ConsoTarifs,
  ConsoTotals,
} from '../types'
import { affichageText, ELEMENTS, elementOf, isShown, setShown, WHERE_LABELS, WHERES } from './affichage'
import type { Affichage, ElementId } from './affichage'
import {
  ago,
  bar,
  barColor,
  chrono,
  clock,
  comma,
  duration,
  exact,
  kindLabel,
  kindShort,
  modelLabel,
  money,
  stamp,
  tokens,
} from './format'
import { joinPath, Ledger, share1hOf } from './journal'
import type { JournalFile, SessionReport } from './journal'
import {
  addTotals,
  bucketOf,
  costOf,
  ECB_URL,
  emptyTotals,
  parseEcb,
  parsePricing,
  PRICING_URL,
  tokensOf,
  totalCost,
} from './prix'

type Dollar = EngineInterface
type UsageLike = { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[]; cost?: SessionCost }

const PANE = 'conso'
const TITLE = 'Conso Claude'
const TICK_MS = 20_000
const PRICES_TTL = 6 * 3600_000
const ALERT_LEVELS = [100, 90, 80]
const ESTIMABLE = new Set(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'])
const DEVISES: readonly ConsoDevise[] = ['usd', 'eur', 'usd+eur']
const DEVISE_LABELS: Record<ConsoDevise, string> = { usd: 'dollars', eur: 'euros', 'usd+eur': 'dollars + euros' }

const snapshot = atom({ plugin: 'conso-tokens', key: 'snapshot' } as const, null)
const totals = atom({ plugin: 'conso-tokens', key: 'totals' } as const, {})
const seeded = atom({ plugin: 'conso-tokens', key: 'seeded' } as const, false)
const share1h = atom({ plugin: 'conso-tokens', key: 'share1h' } as const, 0)
const last = atom({ plugin: 'conso-tokens', key: 'last' } as const, null)
const now = atom({ plugin: 'conso-tokens', key: 'now' } as const, 0)
const anchors = atom({ plugin: 'conso-tokens', key: 'anchors' } as const, {})
const estimates = atom({ plugin: 'conso-tokens', key: 'estimates' } as const, {})
const tarifs = atom({ plugin: 'conso-tokens', key: 'tarifs' } as const, null)
const change = atom({ plugin: 'conso-tokens', key: 'change' } as const, null)
const tarifsErreur = atom({ plugin: 'conso-tokens', key: 'tarifsErreur' } as const, null)
const affichage = atom({ plugin: 'conso-tokens', key: 'affichage' } as const, {})
const reglages = atom({ plugin: 'conso-tokens', key: 'reglages' } as const, false)
const devise = atom({ plugin: 'conso-tokens', key: 'devise' } as const, 'usd+eur')
const tour = atom({ plugin: 'conso-tokens', key: 'tour' } as const, null)
const seconde = atom({ plugin: 'conso-tokens', key: 'seconde' } as const, 0)

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))
const pct = (p: number) => comma(p, Number.isInteger(p) ? 0 : 1)
const sumTokens = (all: ConsoTotals) => Object.values(all).reduce((sum, t) => sum + tokensOf(t), 0)
const isDevise = (value: unknown): value is ConsoDevise => DEVISES.includes(value as ConsoDevise)

function toSnapshot(u: UsageLike, at: number): ConsoSnapshot {
  return {
    ...(u.context.tokens !== undefined ? { contextTokens: u.context.tokens } : {}),
    contextWindow: u.context.window,
    ...(u.context.percent !== undefined ? { contextPercent: u.context.percent } : {}),
    rateLimits: u.rateLimits.map(r => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}),
    })),
    ...(u.cost ? { ledgerUsd: u.cost.usd } : {}),
    at,
  }
}

/** Le prix de la session au tarif officiel ; undefined tant que la grille n'est pas lue. */
async function sessionCost($: Dollar) {
  const grid = await read($, tarifs)
  if (!grid) return undefined
  return totalCost(await read($, totals), grid.models, await read($, share1h))
}

async function priceText($: Dollar, usd: number): Promise<string> {
  return money(usd, await read($, devise), (await read($, change))?.usdPerEur)
}

/** La conso en une ligne (forfait, réinitialisation, tokens, prix), selon `show`. */
async function consoParts($: Dollar, show: (id: ElementId) => boolean): Promise<string[]> {
  const snap = await read($, snapshot)
  const at = Date.now()
  const parts: string[] = []
  for (const w of snap?.rateLimits ?? []) {
    const left = w.resetsAt ? Date.parse(w.resetsAt) - at : undefined
    const hasCountdown = show('ligne-reinit') && left !== undefined && w.kind === 'five_hour'
    if (!show('ligne-forfait')) {
      if (hasCountdown && left > 0) parts.push(`${kindShort(w.kind)} ↻ ${duration(left)}`)
    } else if (left !== undefined && left <= 0) {
      parts.push(`${kindShort(w.kind)} réinitialisée`)
    } else {
      parts.push(`${kindShort(w.kind)} ${pct(w.percentUsed)} %${hasCountdown ? ` ↻ ${duration(left)}` : ''}`)
    }
  }
  if (show('ligne-tokens')) parts.push(`session ${tokens(sumTokens(await read($, totals)))} tokens`)
  if (show('prix') && show('ligne-prix')) {
    const cost = await sessionCost($)
    if (cost) parts.push(await priceText($, cost.usd))
  }
  return parts
}

async function paintStatus($: Dollar) {
  const shown = await read($, affichage)
  const parts = await consoParts($, id => isShown(shown, id))
  $.ui.status(parts.length > 0 ? parts.join(' · ') : undefined)
}

const TOOL_LABELS: Record<string, string> = {
  Bash: 'lance une commande',
  PowerShell: 'lance une commande',
  Read: 'lit un fichier',
  Edit: 'modifie un fichier',
  Write: 'écrit un fichier',
  Grep: 'cherche dans les fichiers',
  Glob: 'cherche des fichiers',
  WebFetch: 'lit une page web',
  WebSearch: 'cherche sur le web',
  Agent: 'lance un sous-agent',
  Skill: 'charge un skill',
}

const toolEtat = (tool: string) => `Outil : ${TOOL_LABELS[tool] ?? tool}`

/** Le chrono de la bande : une écriture par seconde, seulement pendant un tour. */
let ticker: { cancel: () => void } | undefined

function startTicker($: Dollar) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    void (async () => {
      const current = await read($, tour)
      if (!current || current.endedAt !== undefined) return stopTicker()
      await update($, seconde, () => Date.now())
    })()
  })
}

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

/** Change ce que la bande dit que Claude fait ; n'écrit que si ça change. */
async function setEtat($: Dollar, etat: string) {
  const current = await read($, tour)
  if (!current || current.endedAt !== undefined || current.etat === etat) return
  await update($, tour, t => (t && t.endedAt === undefined ? { ...t, etat } : t))
}

/** Calibre la taille des fenêtres : tokens dépensés ici / points de % gagnés. */
async function calibrate($: Dollar, snap: ConsoSnapshot) {
  const spent = sumTokens(await read($, totals))
  const usd = (await sessionCost($))?.usd
  for (const w of snap.rateLimits) {
    const resetsAt = w.resetsAt
    if (!resetsAt || !ESTIMABLE.has(w.kind)) continue
    const anchor = (await read($, anchors))[w.kind]
    const isSameWindow =
      anchor !== undefined &&
      Math.abs(Date.parse(anchor.resetsAt) - Date.parse(resetsAt)) < 10 * 60_000 &&
      w.percentUsed >= anchor.percent
    if (!anchor || !isSameWindow) {
      const fresh = { resetsAt, percent: w.percentUsed, tokens: spent, ...(usd !== undefined ? { usd } : {}) }
      await update($, anchors, all => ({ ...all, [w.kind]: fresh }))
      continue
    }
    const points = w.percentUsed - anchor.percent
    const delta = spent - anchor.tokens
    if (points < 1 || delta <= 0) continue
    const estimate: ConsoEstimate = {
      capacityTokens: Math.round((delta * 100) / points),
      ...(usd !== undefined && anchor.usd !== undefined ? { capacityUsd: ((usd - anchor.usd) * 100) / points } : {}),
      points,
      at: snap.at,
    }
    const all = await update($, estimates, list => ({ ...list, [w.kind]: estimate }))
    await $.store.set('estimates', all)
  }
}

/** Un toast quand une fenêtre passe 80, 90 puis 100 %, une fois par fenêtre. */
async function alert($: Dollar, snap: ConsoSnapshot) {
  const stored = ((await $.store.get('alertes')) ?? {}) as Record<string, { resetsAt?: string; level: number }>
  let isChanged = false
  for (const w of snap.rateLimits) {
    const level = ALERT_LEVELS.find(l => w.percentUsed >= l)
    if (level === undefined) continue
    const previous = stored[w.kind]
    if (previous && previous.resetsAt === w.resetsAt && previous.level >= level) continue
    stored[w.kind] = { ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), level }
    isChanged = true
    const reset = w.resetsAt ? ` — réinitialisation dans ${duration(Date.parse(w.resetsAt) - snap.at)}` : ''
    $.ui.toast(`${kindLabel(w.kind)} : ${pct(w.percentUsed)} % utilisés${reset}`, { timeoutMs: 8000 })
  }
  if (isChanged) await $.store.set('alertes', stored)
}

async function absorb($: Dollar, u: UsageLike) {
  const at = Date.now()
  const snap = toSnapshot(u, at)
  await update($, snapshot, () => snap)
  await update($, now, () => at)
  await calibrate($, snap)
  await alert($, snap)
  await paintStatus($)
}

/** Relit la grille officielle et le taux BCE quand ils ont plus de 6 h (ou sur demande). */
async function refreshPrices($: Dollar, isForced: boolean) {
  const at = Date.now()
  const cached = (await $.store.get('tarifs')) as ConsoTarifs | undefined
  if (cached && !(await read($, tarifs))) await update($, tarifs, () => cached)
  const cachedFx = (await $.store.get('change')) as ConsoChange | undefined
  if (cachedFx && !(await read($, change))) await update($, change, () => cachedFx)

  if (isForced || !cached || at - cached.fetchedAt > PRICES_TTL) {
    try {
      const response = await $.http.fetch(PRICING_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const models = parsePricing(response.text)
      if (Object.keys(models).length === 0) throw new Error('tableau des prix introuvable dans la page')
      const fresh: ConsoTarifs = { models, fetchedAt: at, url: PRICING_URL }
      await update($, tarifs, () => fresh)
      await $.store.set('tarifs', fresh)
      await update($, tarifsErreur, () => null)
    } catch (err) {
      const fallback = cached ? ` ; grille du ${stamp(cached.fetchedAt)} utilisée` : ''
      await update($, tarifsErreur, () => `tarifs officiels injoignables (${reason(err)})${fallback}`)
    }
  }

  if (isForced || !cachedFx || at - cachedFx.fetchedAt > PRICES_TTL) {
    try {
      const response = await $.http.fetch(ECB_URL)
      const rate = response.ok ? parseEcb(response.text) : undefined
      if (rate) {
        const fresh: ConsoChange = { ...rate, fetchedAt: at }
        await update($, change, () => fresh)
        await $.store.set('change', fresh)
      }
    } catch {
      // Le dernier taux connu reste ; sans taux, les montants restent en dollars.
    }
  }
  await paintStatus($)
}

async function isWindows($: Dollar): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

/** Le dossier `projects` de Claude Code, où sont rangés les journaux de session. */
async function projectsDir($: Dollar): Promise<{ dir: string; sep: string }> {
  const sep = (await isWindows($)) ? '\\' : '/'
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const root = configured ?? joinPath(sep, home, '.claude')

  return { dir: joinPath(sep, root, 'projects'), sep }
}

/** Tous les journaux de session, de tous les projets. */
async function listJournals($: Dollar): Promise<JournalFile[]> {
  const { dir, sep } = await projectsDir($)
  const files: JournalFile[] = []
  for (const project of await $.fs.list(dir).catch(() => [])) {
    if (project.kind !== 'dir') continue
    const folder = joinPath(sep, dir, project.name)
    for (const entry of await $.fs.list(folder).catch(() => [])) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
      files.push({
        id: entry.name.slice(0, -'.jsonl'.length),
        path: joinPath(sep, folder, entry.name),
        folder,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      })
    }
  }
  return files
}

const sepOf = (file: JournalFile) => (file.path.includes('\\') ? '\\' : '/')

/** Le titre rangé à côté du journal par l'app de bureau. */
async function savedTitle($: Dollar, file: JournalFile): Promise<string | undefined> {
  try {
    const text = await $.fs.read(joinPath(sepOf(file), file.folder, file.id, 'custom-title.json'))
    const parsed = JSON.parse(text)
    return typeof parsed?.customTitle === 'string' ? parsed.customTitle : undefined
  } catch {
    return undefined
  }
}

/** Lit un fichier ligne à ligne ; au-delà de 4 Mio (la limite de `$.fs.read`), par `type` ou `cat`. */
async function eachLine($: Dollar, path: string, size: number, onLine: (line: string) => void) {
  if (size < 4_000_000) {
    for (const line of (await $.fs.read(path)).split('\n')) onLine(line)
    return
  }
  const argv = (await isWindows($)) ? ['cmd.exe', '/d', '/c', 'type', path] : ['cat', path]
  let rest = ''
  for await (const piece of $.process.spawn({ argv })) {
    if (piece.stream !== 'stdout') continue
    const parts = (rest + piece.text).split('\n')
    rest = parts.pop() ?? ''
    for (const line of parts) onLine(line)
  }
  if (rest) onLine(rest)
}

/** Lit le journal d'une session, et ceux de ses sous-agents, et en fait le compte exact. */
async function readSession($: Dollar, file: JournalFile): Promise<SessionReport> {
  const ledger = new Ledger()
  await eachLine($, file.path, file.size, line => ledger.add(line))
  const mainIds = new Set(ledger.records.keys())

  const subFolder = joinPath(sepOf(file), file.folder, file.id, 'subagents')
  for (const entry of await $.fs.list(subFolder).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    await eachLine($, joinPath(sepOf(file), subFolder, entry.name), entry.size, line => ledger.add(line))
  }

  const title = ledger.title ?? (await savedTitle($, file))
  return {
    id: file.id,
    path: file.path,
    ...(title ? { title } : {}),
    ...ledger.span(),
    totals: ledger.totals(),
    subagentRequests: [...ledger.records.keys()].filter(id => !mainIds.has(id)).length,
  }
}

async function currentJournal($: Dollar): Promise<JournalFile | undefined> {
  const id = await $.session.id()
  return (await listJournals($)).find(file => file.id === id)
}

/** Une fois par session : le compte exact depuis son début, lu dans son journal. */
async function seed($: Dollar) {
  if (await read($, seeded)) return
  const file = await currentJournal($)
  const report = file ? await readSession($, file) : undefined
  await update($, totals, () => report?.totals ?? {})
  await update($, share1h, () => (report ? share1hOf(report.totals) : 0))
  await update($, seeded, () => true)
  await update($, anchors, () => ({}))
  await paintStatus($)
}

async function loadPrefs($: Dollar, options: PluginOptions) {
  const stored = ((await $.store.get('affichage')) ?? {}) as Affichage
  const shown = stored.prix === undefined && options.prix === false ? { ...stored, prix: false } : stored
  await update($, affichage, () => shown)

  const storedDevise = await $.store.get('devise')
  const chosen = isDevise(storedDevise) ? storedDevise : isDevise(options.devise) ? options.devise : 'usd+eur'
  await update($, devise, () => chosen)

  const storedEstimates = (await $.store.get('estimates')) as Record<string, ConsoEstimate> | undefined
  if (storedEstimates && Object.keys(await read($, estimates)).length === 0) {
    await update($, estimates, () => storedEstimates)
  }
}

async function setAffichage($: Dollar, ids: ReadonlyArray<ElementId | 'tout'>, isVisible: boolean) {
  const shown = await update($, affichage, current => setShown(current, ids, isVisible))
  await $.store.set('affichage', shown)
  if (isVisible && isShown(shown, 'prix')) await refreshPrices($, false)
  await paintStatus($)
}

async function setDevise($: Dollar, chosen: ConsoDevise) {
  await update($, devise, () => chosen)
  await $.store.set('devise', chosen)
  await paintStatus($)
}

async function openPane($: Dollar) {
  await $.store.set('ouvrir', true)
  return $.ui.open({ id: PANE, title: TITLE })
}

/** Regroupe les cumuls « |long » sous leur modèle pour l'affichage. */
function byModel(all: ConsoTotals): Array<[string, ConsoModelTotals, string[]]> {
  const groups = new Map<string, { t: ConsoModelTotals; keys: string[] }>()
  for (const [key, t] of Object.entries(all)) {
    const model = key.split('|')[0]!
    const group = groups.get(model) ?? { t: emptyTotals(), keys: [] }
    group.t = addTotals(group.t, t)
    group.keys.push(key)
    groups.set(model, group)
  }
  return [...groups.entries()]
    .map(([model, g]): [string, ConsoModelTotals, string[]] => [model, g.t, g.keys])
    .sort((a, b) => tokensOf(b[1]) - tokensOf(a[1]))
}

async function reportText($: Dollar, report: SessionReport, file: JournalFile): Promise<string> {
  const isPrix = isShown(await read($, affichage), 'prix')
  const grid = await read($, tarifs)
  const fx = await read($, change)
  const chosen = await read($, devise)
  const fmt = (usd: number) => money(usd, chosen, fx?.usdPerEur)
  const share = share1hOf(report.totals)
  const models = byModel(report.totals)
  const requests = models.reduce((sum, [, t]) => sum + t.requests, 0)
  const folder = file.folder.split(/[\\/]/).pop() ?? file.folder

  const lines: string[] = []
  lines.push(`Consommation exacte de la session${report.title ? ` « ${report.title} »` : ''}`)
  lines.push(`id ${report.id} · projet ${folder}`)
  if (report.firstAt && report.lastAt) {
    lines.push(`du ${stamp(Date.parse(report.firstAt))} au ${stamp(Date.parse(report.lastAt))}`)
  }
  const subagents = report.subagentRequests > 0 ? ` (dont ${report.subagentRequests} de sous-agents)` : ''
  lines.push(`${exact(requests)} réponses du modèle${subagents}`)

  if (requests === 0) {
    lines.push('', 'Aucune réponse du modèle enregistrée dans ce journal pour l’instant.')
    return lines.join('\n')
  }

  let totalUsd = 0
  const unpriced: string[] = []
  for (const [model, t, keys] of models) {
    lines.push('', `${modelLabel(model)} · ${exact(t.requests)} requêtes · ${exact(tokensOf(t))} tokens`)
    lines.push(`  entrée (hors cache) : ${exact(t.input)}`)
    lines.push(`  sortie : ${exact(t.output)}`)
    lines.push(`  cache lu : ${exact(t.cacheRead)}`)
    lines.push(`  cache écrit : ${exact(t.write5m)} (5 min) + ${exact(t.write1h)} (1 h)`)
    if (isPrix && grid) {
      const costs = keys.map(key => costOf(key, report.totals[key]!, grid.models, share))
      if (costs.some(cost => cost === undefined)) {
        unpriced.push(modelLabel(model))
        lines.push('  prix : pas de tarif officiel pour ce modèle')
      } else {
        const usd = costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0)
        totalUsd += usd
        lines.push(`  prix : ${fmt(usd)}`)
      }
    }
  }

  const allTokens = models.reduce((sum, [, t]) => sum + tokensOf(t), 0)
  lines.push('', `Total : ${exact(allTokens)} tokens${isPrix && grid ? ` · ${fmt(totalUsd)}` : ''}`)
  if (isPrix) {
    if (grid) {
      const rate = fx ? ` ; 1 € = ${comma(fx.usdPerEur, 4)} $ (BCE, ${fx.date})` : ''
      lines.push(`Prix : tarifs officiels lus sur platform.claude.com le ${stamp(grid.fetchedAt)}${rate}.`)
      if (unpriced.length > 0) lines.push(`Sans tarif officiel (exclus du total) : ${unpriced.join(', ')}.`)
      lines.push('Avec un abonnement, ce prix est l’équivalent au tarif de l’API, pas ce qui est facturé.')
    } else {
      const err = await read($, tarifsErreur)
      lines.push(`Prix indisponible : ${err ?? 'grille officielle pas encore lue'}.`)
    }
  }
  lines.push('Compté depuis le journal de la session (chaque réponse une fois, sous-agents compris).')

  return lines.join('\n')
}

async function listText($: Dollar): Promise<string> {
  const files = (await listJournals($)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12)
  if (files.length === 0) return 'Aucun journal de session trouvé.'
  const current = await $.session.id()
  const lines = ['Dernières sessions (la plus récente d’abord) :']
  for (const file of files) {
    const title = (await savedTitle($, file)) ?? file.folder.split(/[\\/]/).pop()
    const size = `${comma(file.size / 1_048_576, 1)} Mo`
    const mark = file.id === current ? ' (celle-ci)' : ''
    lines.push(`${file.id.slice(0, 8)} · ${stamp(file.mtimeMs)} · ${size} · ${title}${mark}`)
  }
  lines.push('', '/conso-session <début de l’id> donne le compte exact d’une session.')
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'conso',
      description:
        'Panneau de consommation : forfait, tokens, prix en direct (/conso affichage, /conso masquer prix, /conso devise eur)',
    })
    await $.command.register({
      name: 'conso-session',
      description: 'Consommation exacte d’une seule session : celle-ci, un id, ou « liste »',
    })
    await loadPrefs($, options)
    $.clock.every(TICK_MS, () => {
      void update($, now, () => Date.now()).then(() => paintStatus($))
    })
    const running = await read($, tour)
    if (running && running.endedAt === undefined) startTicker($)

    void (async () => {
      await absorb($, await $.session.usage()).catch(() => undefined)
      await refreshPrices($, false).catch(() => undefined)
      await seed($).catch(err => $.ui.log(`conso-tokens : journal illisible (${reason(err)})`, { to: 'debug' }))
      const wantsPane = options.ouvrirAuDemarrage !== false && (await $.store.get('ouvrir')) !== false
      if (wantsPane) await $.ui.open({ id: PANE, title: TITLE })
    })()

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await absorb($, e).catch(() => undefined)
    return result
  })

  on('turn.start', async ($, e, next) => {
    try {
      await update($, tour, () => ({ startedAt: Date.now(), etat: 'Envoi de la demande', totals: {} }))
      await update($, seconde, () => Date.now())
      startTicker($)
    } catch {
      // La bande ne doit jamais gêner le tour.
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const stream = next(e)
    let etat = ''
    const follow = async (now: string) => {
      if (now === etat) return
      etat = now
      try {
        await setEtat($, now)
      } catch {
        // idem : rien ne bloque la réponse
      }
    }
    await follow(isMain ? 'Attente de l’API' : 'Un sous-agent travaille')
    for await (const chunk of stream) {
      if (isMain && chunk.kind === 'thinking') await follow('Réflexion en cours')
      else if (isMain && chunk.kind === 'text') await follow('Écrit la réponse')
      else if (isMain && chunk.kind === 'tool') await follow(`Prépare un outil : ${TOOL_LABELS[chunk.name] ?? chunk.name}`)
      yield chunk
    }
    const result = await stream.result
    try {
      const usage = result.usage
      if (usage) {
        const one: ConsoModelTotals = {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens,
          write5m: 0,
          write1h: 0,
          writeUnknown: usage.cache_creation_input_tokens,
          requests: 1,
        }
        const key = bucketOf(usage.model, one)
        const add = (all: ConsoTotals) => ({ ...all, [key]: addTotals(all[key] ?? emptyTotals(), one) })
        await update($, totals, add)
        await update($, tour, t => (t && t.endedAt === undefined ? { ...t, totals: add(t.totals) } : t))
        await update($, last, () => ({ key, usage: one, at: Date.now() }))
        await paintStatus($)
      }
    } catch {
      // Le compte en direct ne doit jamais gêner la réponse du modèle.
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    if (isMain) await setEtat($, toolEtat(e.tool)).catch(() => undefined)
    const result = await next(e)
    if (isMain) await setEtat($, 'Attente de l’API').catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        const etat = e.isAborted ? 'Interrompu' : 'Terminé'
        const endedAt = Date.now()
        await update($, tour, t =>
          t ? { ...t, etat, endedAt, startedAt: t.endedAt === undefined ? endedAt - e.durationMs : t.startedAt } : t,
        )
        stopTicker()
      } catch {
        // La bande garde son dernier état.
      }
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, totals, () => ({}))
      await update($, last, () => null)
      await update($, anchors, () => ({}))
      await update($, seeded, () => true)
    }
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await $.store.set('ouvrir', false)
      $.ui.toast('Panneau fermé : /conso pour le rouvrir')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'conso' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (word === 'prix') {
      const isVisible =
        value === 'on' ? true : value === 'off' ? false : !isShown(await read($, affichage), 'prix')
      await setAffichage($, ['prix'], isVisible)
      return { text: isVisible ? 'Prix en direct affiché (tarifs officiels Anthropic).' : 'Prix en direct masqué.' }
    }
    if (word === 'affichage') {
      return { text: affichageText(await read($, affichage)) }
    }
    if (word === 'afficher' || word === 'masquer') {
      const words = e.args.trim().split(/\s+/).slice(1)
      const ids = words.map(elementOf)
      const unknown = words.filter((_, i) => ids[i] === undefined)
      if (words.length === 0 || unknown.length > 0) {
        const list = ELEMENTS.map(element => element.id).join(', ')
        const what = unknown.length > 0 ? `Inconnu : ${unknown.join(', ')}. ` : ''
        return { text: `${what}Éléments possibles : ${list}, ou « tout ».` }
      }
      const isVisible = word === 'afficher'
      await setAffichage($, ids as Array<ElementId | 'tout'>, isVisible)
      return { text: `${isVisible ? 'Affiché' : 'Masqué'} : ${words.join(', ')}.` }
    }
    if (word === 'devise') {
      const wanted = value === 'les-deux' || value === 'deux' ? 'usd+eur' : value
      if (!isDevise(wanted)) return { text: 'Devises possibles : /conso devise usd, eur ou les-deux.' }
      await setDevise($, wanted)
      return { text: `Prix affichés en ${DEVISE_LABELS[wanted]}.` }
    }
    if (word === 'actualiser') {
      await refreshPrices($, true)
      await absorb($, await $.session.usage())
      return { text: 'Limites et tarifs officiels relus.' }
    }

    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Panneau « Conso Claude » ouvert.' : `Panneau en attente : ${opened.reason}` }
  })

  on('command.run', { command: 'conso-session' }, async ($, e) => {
    const arg = e.args.trim()
    if (/^(liste|list|ls)$/i.test(arg)) return { text: await listText($) }

    const wanted = arg || (await $.session.id())
    const files = await listJournals($)
    const exactFile = files.find(file => file.id === wanted)
    const matches = exactFile ? [exactFile] : files.filter(file => file.id.startsWith(wanted))
    if (matches.length === 0) {
      return { text: `Aucune session ne commence par « ${wanted} ». /conso-session liste montre les dernières.` }
    }
    if (matches.length > 1) {
      const ids = matches.slice(0, 6).map(file => file.id).join(', ')
      return { text: `Plusieurs sessions commencent par « ${wanted} » : ${ids}. Donne quelques caractères de plus.` }
    }

    if (isShown(await read($, affichage), 'prix')) await refreshPrices($, false)
    const file = matches[0]!
    const report = await readSession($, file)
    return { text: await reportText($, report, file) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, affichage)
    const showTour = isShown(shown, 'bande-tour')
    const showConso = isShown(shown, 'bande-conso')
    if (e.props.hasSurvey || (!showTour && !showConso)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const current = showTour ? await read($, tour) : null
    const tick = await read($, seconde)
    const conso = showConso ? await consoParts($, id => (id === 'prix' ? isShown(shown, 'prix') : true)) : []
    if (!current && conso.length === 0) return next(e)

    let tourLine: string | undefined
    let isRunning = false
    if (current) {
      isRunning = current.endedAt === undefined
      const endsAt = current.endedAt ?? Math.max(tick, Date.now())
      const flat = Object.values(current.totals).reduce(addTotals, emptyTotals())
      const grid = isShown(shown, 'prix') ? await read($, tarifs) : null
      const cost = grid ? totalCost(current.totals, grid.models, await read($, share1h)).usd : undefined
      const price = cost !== undefined && flat.requests > 0 ? ` · ${await priceText($, cost)}` : ''
      const head = isRunning ? '' : 'Dernier tour : '
      const tail = isRunning ? current.etat : `${current.etat} à ${clock(endsAt, Date.now())}`
      tourLine = `${head}${chrono(endsAt - current.startedAt)} · ${tokens(flat.output)} tokens écrits${price} · ${tail}`
    }

    return (
      <Box flexDirection="column">
        {tourLine && (
          <Text wrap="truncate-end">
            <Text color={isRunning ? 'yellow' : current?.etat === 'Interrompu' ? 'red' : 'green'}>
              {isRunning ? '●' : current?.etat === 'Interrompu' ? '■' : '✓'}
            </Text>{' '}
            <Text dimColor={!isRunning}>{tourLine}</Text>
          </Text>
        )}
        {conso.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {conso.join(' · ')}
          </Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const shown = await read($, affichage)
    const show = (id: ElementId) => isShown(shown, id)

    if (await read($, reglages)) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Choisir ce qui s’affiche</Text>
          {WHERES.map(where => (
            <Box flexDirection="column">
              <Text dimColor>{WHERE_LABELS[where]}</Text>
              {ELEMENTS.filter(element => element.where === where).map(element => (
                <Button
                  key={`aff-${element.id}`}
                  label={`${show(element.id) ? '☑' : '☐'} ${element.label}`}
                  plain
                  onPress={() => setAffichage($, [element.id], !show(element.id))}
                />
              ))}
            </Box>
          ))}
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key="aff-tout" label="Tout afficher" onPress={() => setAffichage($, ['tout'], true)} />
            <Button key="aff-fini" label="Terminé" variant="primary" onPress={() => update($, reglages, () => false)} />
          </Box>
        </Box>
      )
    }

    const snap = await read($, snapshot)
    const all = await read($, totals)
    const lastRequest = await read($, last)
    const at = (await read($, now)) || Date.now()
    const known = await read($, estimates)
    const isPrix = show('prix')
    const grid = await read($, tarifs)
    const fx = await read($, change)
    const chosen = await read($, devise)
    const share = await read($, share1h)
    const err = await read($, tarifsErreur)
    const isSeeded = await read($, seeded)
    const width = Math.max(10, Math.min(36, e.props.bodyColumns - 2))
    const fmt = (usd: number) => money(usd, chosen, fx?.usdPerEur)

    const windows = snap?.rateLimits ?? []
    const flat = Object.values(all).reduce(addTotals, emptyTotals())
    const cost = grid ? totalCost(all, grid.models, share) : undefined
    const lastCost =
      grid && lastRequest ? costOf(lastRequest.key, lastRequest.usage, grid.models, share) : undefined
    const hasSession = show('session') || show('detail') || show('contexte') || (isPrix && cost !== undefined)
    const isEmpty =
      !show('forfait') && !show('estimation') && !hasSession && !show('derniere') && !(isPrix && show('tarifs'))

    return (
      <Box flexDirection="column" gap={1}>
        {isEmpty && <Text dimColor>Tout est masqué : le bouton Affichage remet ce que tu veux voir.</Text>}

        {show('forfait') && (
          <Box flexDirection="column">
            <Text bold>Forfait</Text>
            {windows.length === 0 && (
              <Text dimColor>En attente d’une réponse de l’API (ou session sans abonnement).</Text>
            )}
            {windows.map(w => {
              const resetAt = w.resetsAt ? Date.parse(w.resetsAt) : undefined
              const isPast = resetAt !== undefined && resetAt <= at
              const when =
                resetAt === undefined
                  ? 'heure de réinitialisation inconnue'
                  : isPast
                    ? `réinitialisée à ${clock(resetAt, at)} ; le % se met à jour à la prochaine réponse`
                    : `réinitialisation dans ${duration(resetAt - at)} (${clock(resetAt, at)})`
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Text>
                    {kindLabel(w.kind)} : <Text bold color={barColor(w.percentUsed)}>{isPast ? '0' : pct(w.percentUsed)} %</Text>
                  </Text>
                  <Text color={isPast ? 'gray' : barColor(w.percentUsed)}>{bar(isPast ? 0 : w.percentUsed, width)}</Text>
                  <Text dimColor>{when}</Text>
                </Box>
              )
            })}
          </Box>
        )}

        {show('estimation') && windows.some(w => ESTIMABLE.has(w.kind)) && (
          <Box flexDirection="column">
            <Text bold>Estimation du forfait</Text>
            {windows
              .filter(w => ESTIMABLE.has(w.kind))
              .map(w => {
                const estimate = known[w.kind]
                if (!estimate) {
                  return <Text dimColor>{kindShort(w.kind)} : calibrage en cours (il faut que le % monte d’au moins 1 point)</Text>
                }
                const left = (estimate.capacityTokens * Math.max(0, 100 - w.percentUsed)) / 100
                const usd = estimate.capacityUsd !== undefined && isPrix ? ` (≈ ${fmt(estimate.capacityUsd)} au tarif API)` : ''
                const old = at - estimate.at > 6 * 3600_000 ? ` · mesure du ${stamp(estimate.at)}` : ''
                return (
                  <Text>
                    {kindShort(w.kind)} : ~{tokens(estimate.capacityTokens)} tokens par fenêtre{usd} · reste ~{tokens(left)}
                    <Text dimColor>{old}</Text>
                  </Text>
                )
              })}
            <Text dimColor>
              Déduit de cette session (tokens dépensés / points de % gagnés) : plus bas que la réalité si d’autres sessions ou
              claude.ai consomment en même temps.
            </Text>
          </Box>
        )}

        {hasSession && (
          <Box flexDirection="column">
            <Text bold>Cette session</Text>
            {!isSeeded && <Text dimColor>Lecture du journal de la session…</Text>}
            {show('session') && (
              <Text>
                {exact(tokensOf(flat))} tokens · {exact(flat.requests)} requêtes
              </Text>
            )}
            {show('detail') && (
              <Text dimColor>
                entrée {tokens(flat.input)} · sortie {tokens(flat.output)} · cache lu {tokens(flat.cacheRead)} · cache écrit{' '}
                {tokens(flat.write5m + flat.write1h + flat.writeUnknown)}
              </Text>
            )}
            {isPrix && cost && (
              <Text>
                Prix (tarifs officiels) : <Text bold>{fmt(cost.usd)}</Text>
              </Text>
            )}
            {isPrix && cost && cost.unknown.length > 0 && (
              <Text dimColor>sans tarif officiel : {cost.unknown.map(modelLabel).join(', ')}</Text>
            )}
            {isPrix && show('tarifs') && snap?.ledgerUsd !== undefined && (
              <Text dimColor>selon Claude Code (ses tarifs intégrés, toutes requêtes) : {fmt(snap.ledgerUsd)}</Text>
            )}
            {show('contexte') && snap?.contextTokens !== undefined && (
              <Text dimColor>
                contexte : {tokens(snap.contextTokens)} / {tokens(snap.contextWindow)} ({snap.contextPercent ?? 0} %)
              </Text>
            )}
          </Box>
        )}

        {show('derniere') && lastRequest && (
          <Box flexDirection="column">
            <Text bold>Dernière requête</Text>
            <Text>
              {tokens(tokensOf(lastRequest.usage))} tokens (sortie {tokens(lastRequest.usage.output)}) ·{' '}
              {modelLabel(lastRequest.key)}
              {isPrix && lastCost !== undefined ? ` · ${fmt(lastCost)}` : ''}
            </Text>
            <Text dimColor>{ago(Math.max(0, at - lastRequest.at))}</Text>
          </Box>
        )}

        {isPrix && show('tarifs') && (
          <Box flexDirection="column">
            {grid && (
              <Text dimColor>
                Tarifs officiels lus sur platform.claude.com le {stamp(grid.fetchedAt)}
                {fx ? ` · 1 € = ${comma(fx.usdPerEur, 4)} $ (BCE, ${fx.date})` : ''}
              </Text>
            )}
            {err && <Text color="yellow">{err}</Text>}
            {!grid && !err && <Text dimColor>Lecture des tarifs officiels…</Text>}
          </Box>
        )}

        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button
            key="actualiser"
            label="Actualiser"
            onPress={async () => {
              await refreshPrices($, true)
              await absorb($, await $.session.usage())
            }}
          />
          <Button key="affichage" label="Affichage" onPress={() => update($, reglages, () => true)} />
          <Button
            key="prix"
            label={isPrix ? 'Masquer le prix' : 'Afficher le prix'}
            onPress={() => setAffichage($, ['prix'], !isPrix)}
          />
          {isPrix && (
            <Button
              key="devise"
              label={`Devise : ${DEVISE_LABELS[chosen]}`}
              onPress={() => setDevise($, DEVISES[(DEVISES.indexOf(chosen) + 1) % DEVISES.length]!)}
            />
          )}
          <Button
            key="fermer"
            label="Fermer"
            role="dismiss"
            onPress={async () => {
              await $.store.set('ouvrir', false)
              await $.ui.close({ id: PANE })
            }}
          />
        </Box>
      </Box>
    )
  })
}

