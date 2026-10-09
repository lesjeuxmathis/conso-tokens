/** Une fenêtre de limite telle que la dernière réponse de l'API l'a donnée. */
export type ConsoWindow = { kind: string; percentUsed: number; resetsAt?: string }

/** Ce que `$.session.usage()` répond, à plat, avec l'heure de la lecture. */
export type ConsoSnapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: ConsoWindow[]
  /** Le coût que Claude Code calcule lui-même (ses tarifs intégrés). */
  ledgerUsd?: number
  at: number
}

/**
 * Tokens d'un modèle. `writeUnknown` : écritures de cache comptées en direct,
 * dont l'API ne dit pas si elles sont à 5 min ou à 1 h (le journal, lui, le dit).
 */
export type ConsoModelTotals = {
  input: number
  output: number
  cacheRead: number
  write5m: number
  write1h: number
  writeUnknown: number
  requests: number
}

/** Tokens par modèle ; la clé `<modèle>|long` regroupe les prompts de plus de 100 000 tokens. */
export type ConsoTotals = Record<string, ConsoModelTotals>

/** La dernière requête au modèle. */
export type ConsoLast = { key: string; usage: ConsoModelTotals; at: number }

/** Point de départ d'une calibration : % et tokens au moment où on l'a pris. */
export type ConsoAnchor = { resetsAt: string; percent: number; tokens: number; usd?: number }

/** Taille estimée d'une fenêtre, déduite de ce que la session a consommé. */
export type ConsoEstimate = {
  capacityTokens: number
  capacityUsd?: number
  points: number
  at: number
}

/** Tarifs d'un modèle en dollars par million de tokens. */
export type ConsoRates = {
  input: number
  write5m: number
  write1h: number
  read: number
  output: number
}

export type ConsoPrice = ConsoRates & {
  name: string
  /** Tarif des prompts au-delà de `longAbove` tokens, quand la page en donne un. */
  long?: ConsoRates
  longAbove?: number
}

/** La grille officielle telle que lue sur la page de prix d'Anthropic. */
export type ConsoTarifs = { models: Record<string, ConsoPrice>; fetchedAt: number; url: string }

/** Le taux de référence officiel de la BCE. */
export type ConsoChange = { usdPerEur: number; date: string; fetchedAt: number }

export type ConsoDevise = 'usd' | 'eur' | 'usd+eur'

declare module 'claude-code' {
  interface PluginState {
    'conso-tokens': {
      snapshot: ConsoSnapshot | null
      totals: ConsoTotals
      seeded: boolean
      share1h: number
      last: ConsoLast | null
      now: number
      anchors: Record<string, ConsoAnchor>
      estimates: Record<string, ConsoEstimate>
      tarifs: ConsoTarifs | null
      change: ConsoChange | null
      tarifsErreur: string | null
      /** Élément → affiché ou non ; un élément absent est affiché. */
      affichage: Record<string, boolean>
      /** L'écran « Affichage » du panneau est ouvert. */
      reglages: boolean
      devise: ConsoDevise
    }
  }
}
