import { describe, expect, mock, test } from 'claude-code/testing'

import { elementOf, isShown, setShown } from '../hooks/affichage'
import { money } from '../hooks/format'
import { Ledger, share1hOf } from '../hooks/journal'
import { costOf, emptyTotals, parseEcb, parsePricing, priceFor } from '../hooks/prix'

/** Un extrait du tableau « Model pricing » de platform.claude.com, tel quel. */
const PRICING_MD = [
  '## Model pricing',
  '',
  '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
  '| ----- | ----------------- | --------------- | --------------- | ------------------------ | ------------- |',
  '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |',
  '| Claude Opus 4.1 ([retired, except on Bedrock](https://platform.claude.com/x)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |',
  '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |',
  '| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |',
  '| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |',
  '',
  '*<sup>2 Cache hits on Claude Opus 5.5 are priced at 0.05x the base input price.</sup>*',
].join('\n')

const ECB_XML =
  "<gesmes:Envelope><Cube><Cube time='2026-10-07'><Cube currency='JPY' rate='162.1'/>" +
  "<Cube currency='USD' rate='1.0812'/></Cube></Cube></gesmes:Envelope>"

const M = 1_000_000

function expectNear(actual: number | undefined, expected: number) {
  expect(actual).toBeDefined()
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThan(1e-9)
}

describe('grille officielle', () => {
  test('lit le tableau par le titre des colonnes', () => {
    const models = parsePricing(PRICING_MD)
    expect(models['claude-opus-5-5']).toEqual({
      name: 'Claude Opus 5.5',
      input: 4,
      write5m: 5,
      write1h: 8,
      read: 0.2,
      output: 20,
    })
    expect(models['claude-opus-4-1']?.output).toBe(75)
    expect(models['claude-haiku-5-5']?.input).toBe(0.1)
    expect(models['claude-haiku-5-5']?.longAbove).toBe(100_000)
    expect(models['claude-haiku-5-5']?.long?.input).toBe(0.5)
    expect(parsePricing('pas de tableau')).toEqual({})
  })

  test('retrouve le tarif d’un id d’API, daté ou suffixé, et pas celui d’un modèle voisin', () => {
    const models = parsePricing(PRICING_MD)
    expect(priceFor('claude-haiku-4-5-20251001', models)?.input).toBe(1)
    expect(priceFor('claude-opus-5-5[1m]', models)?.input).toBe(4)
    expect(priceFor('us.anthropic.claude-opus-5-5', models)?.input).toBe(4)
    expect(priceFor('claude-opus-5-7', models)).toBeUndefined()
  })

  test('calcule le prix à chaque tarif, cache à 5 min et à 1 h compris', () => {
    const models = parsePricing(PRICING_MD)
    const all = { ...emptyTotals(), input: M, output: M, cacheRead: M, write5m: M, write1h: M }
    expectNear(costOf('claude-opus-5-5', all, models, 0), 4 + 20 + 0.2 + 5 + 8)

    const unknownTtl = { ...emptyTotals(), writeUnknown: M }
    expectNear(costOf('claude-opus-5-5', unknownTtl, models, 0.25), 0.75 * 5 + 0.25 * 8)

    const longPrompt = { ...emptyTotals(), input: M }
    expectNear(costOf('claude-haiku-5-5|long', longPrompt, models, 0), 0.5)
    expectNear(costOf('claude-haiku-5-5', longPrompt, models, 0), 0.1)
    expect(costOf('claude-inconnu-9', longPrompt, models, 0)).toBeUndefined()
  })

  test('lit le taux USD de la BCE et convertit', () => {
    expect(parseEcb(ECB_XML)).toEqual({ usdPerEur: 1.0812, date: '2026-10-07' })
    expect(money(10.8, 'usd+eur', 1.08)).toBe('10,80 $ (≈ 10,00 €)')
    expect(money(10.8, 'eur', 1.08)).toBe('10,00 €')
    expect(money(0.5, 'usd', 1.08)).toBe('0,500 $')
  })
})

describe('journal de session', () => {
  const answer = (id: string, output: number, write5m: number, write1h: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: `2026-10-08T10:0${output % 10}:00.000Z`,
      message: {
        model: 'claude-opus-5-5',
        id,
        role: 'assistant',
        content: [{ type: 'text', text: 'le mot "usage" dans une réponse' }],
        usage: {
          input_tokens: 2,
          output_tokens: output,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: write5m + write1h,
          cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
        },
      },
    })

  test('compte chaque réponse une fois, avec la répartition du cache', () => {
    const ledger = new Ledger()
    ledger.add(answer('msg_a', 5, 10, 0))
    ledger.add(answer('msg_a', 50, 10, 0))
    ledger.add(answer('msg_b', 7, 0, 30))
    ledger.add(JSON.stringify({ type: 'user', toolUseResult: { usage: { input_tokens: 999 } }, message: { role: 'assistant' } }))
    ledger.add(JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', id: 'x', usage: { input_tokens: 5 } } }))
    ledger.add('{"type":"assistant","message":{"usage"')
    ledger.add(JSON.stringify({ type: 'custom-title', customTitle: 'Ma session' }))

    const totals = ledger.totals()
    expect(Object.keys(totals)).toEqual(['claude-opus-5-5'])
    expect(totals['claude-opus-5-5']).toEqual({
      input: 4,
      output: 57,
      cacheRead: 200,
      write5m: 10,
      write1h: 30,
      writeUnknown: 0,
      requests: 2,
    })
    expect(ledger.title).toBe('Ma session')
    expectNear(share1hOf(totals), 0.75)
  })
})

const PANE_PROPS = {
  title: 'Conso Claude',
  isFocused: false,
  bodyColumns: 44,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('le panneau montre le forfait, les tokens en direct et le prix officiel', async ($, on) => {
  mock.store(on)
  on('http.fetch', async (_$, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: e.url.includes('ecb.europa.eu') ? ECB_XML : PRICING_MD,
    },
  }))
  const resetsAt = new Date(Date.now() + (2 * 60 + 14) * 60_000 + 30_000).toISOString()
  const reading = {
    context: { tokens: 50_000, window: 1_000_000, percent: 5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt }],
    cost: { usd: 4.1 },
  }
  on('session.usage', async () => ({ value: { startedAt: 0, ...reading } }))
  on('session.measure', async (_$, e) => ({ changed: [...e.changed] }))
  let status: string | undefined
  on('ui.status', async (_$, e) => {
    status = e.text
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: M,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  })

  await $.session.measure({ ...reading, changed: ['context', 'rateLimits', 'cost'] })
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // le flux est vide : seule la réponse compte
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'conso-tokens',
      surface,
      component: 'Pane',
      requestId: 'conso',
      props: PANE_PROPS,
    })
    await ui.press({ key: 'actualiser' })

    expect(await ui.find({ text: /Fenêtre 5 h/ })).toBeDefined()
    expect(await ui.find({ text: /42 %/ })).toBeDefined()
    expect(await ui.find({ text: /réinitialisation dans 2 h 14/ })).toBeDefined()
    expect(await ui.find({ text: /1 000 000 tokens · 1 requêtes/ })).toBeDefined()
    expect(await ui.find({ text: /4,00 \$ \(≈ 3,70 €\)/ })).toBeDefined()
    expect(await ui.find({ text: /BCE, 2026-10-07/ })).toBeDefined()

    await ui.press({ key: 'prix' })
    expect(await ui.find({ text: /4,00 \$/ })).toBeUndefined()
    await ui.press({ key: 'prix' })

    expect(status).toMatch(/^5 h 42 % ↻ 2 h 14 · session 1,00 M tokens · 4,00 \$/)
    await ui.press({ key: 'affichage' })
    await ui.press({ key: 'aff-session' })
    await ui.press({ key: 'aff-ligne-forfait' })
    await ui.press({ key: 'aff-fini' })
    expect(await ui.find({ text: /1 000 000 tokens · 1 requêtes/ })).toBeUndefined()
    expect(await ui.find({ text: /42 %/ })).toBeDefined()
    expect(status).toMatch(/^5 h ↻ 2 h 14 · session/)

    await ui.press({ key: 'affichage' })
    await ui.press({ key: 'aff-tout' })
    await ui.press({ key: 'aff-fini' })
    expect(await ui.find({ text: /1 000 000 tokens · 1 requêtes/ })).toBeDefined()
    await ui.unmount()
  }
})

test('choisir l’affichage : mots acceptés et réglages', () => {
  expect(elementOf('Prix')).toBe('prix')
  expect(elementOf('tokens')).toBe('session')
  expect(elementOf('tout')).toBe('tout')
  expect(elementOf('n’importe quoi')).toBeUndefined()

  const hidden = setShown({}, ['prix', 'ligne-tokens'], false)
  expect(isShown(hidden, 'prix')).toBe(false)
  expect(isShown(hidden, 'forfait')).toBe(true)
  expect(isShown(setShown(hidden, ['tout'], true), 'prix')).toBe(true)
})
