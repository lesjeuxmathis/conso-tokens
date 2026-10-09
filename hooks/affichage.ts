/** Ce que la personne peut afficher ou masquer, et où cela se voit. */
export const ELEMENTS = [
  { id: 'forfait', label: 'Forfait (5 h, semaine, crédit)', where: 'panneau' },
  { id: 'estimation', label: 'Estimation du forfait en tokens', where: 'panneau' },
  { id: 'session', label: 'Tokens de la session', where: 'panneau' },
  { id: 'detail', label: 'Détail entrée / sortie / cache', where: 'panneau' },
  { id: 'contexte', label: 'Remplissage du contexte', where: 'panneau' },
  { id: 'derniere', label: 'Dernière requête', where: 'panneau' },
  { id: 'tarifs', label: 'Source des tarifs', where: 'panneau' },
  { id: 'prix', label: 'Prix (panneau, ligne d’état, /conso-session)', where: 'partout' },
  { id: 'ligne-forfait', label: '% du forfait', where: 'ligne' },
  { id: 'ligne-reinit', label: 'Compte à rebours de la fenêtre 5 h', where: 'ligne' },
  { id: 'ligne-tokens', label: 'Tokens de la session', where: 'ligne' },
  { id: 'ligne-prix', label: 'Prix', where: 'ligne' },
  { id: 'bande-tour', label: 'Tour de Claude : chrono, tokens, ce qu’il fait', where: 'bande' },
  { id: 'bande-conso', label: 'Forfait, tokens et prix de la session', where: 'bande' },
] as const

export type ElementId = (typeof ELEMENTS)[number]['id']
export type Affichage = Record<string, boolean>

export const WHERE_LABELS = {
  panneau: 'Panneau',
  partout: 'Partout',
  ligne: 'Ligne d’état',
  bande: 'Bande au-dessus de la saisie (toujours visible)',
} as const

/** L'ordre des groupes dans /conso affichage et dans l'écran Affichage. */
export const WHERES = ['bande', 'panneau', 'ligne', 'partout'] as const

/** Tout est affiché tant que la personne n'a rien masqué. */
export const isShown = (affichage: Affichage, id: ElementId) => affichage[id] !== false

const ALIASES: Record<string, ElementId> = {
  limites: 'forfait',
  estimations: 'estimation',
  tokens: 'session',
  details: 'detail',
  'détail': 'detail',
  'dernière': 'derniere',
  requete: 'derniere',
  source: 'tarifs',
  statut: 'ligne-forfait',
  bande: 'bande-tour',
  chrono: 'bande-tour',
  rebours: 'ligne-reinit',
}

/** Un mot tapé après /conso afficher ou masquer → l'élément, « tout », ou rien. */
export function elementOf(word: string): ElementId | 'tout' | undefined {
  const w = word.trim().toLowerCase()
  if (w === 'tout' || w === 'tous') return 'tout'
  const known = ELEMENTS.find(element => element.id === w)
  return known ? known.id : ALIASES[w]
}

/** Affiche ou masque des éléments ; « tout » les règle tous. */
export function setShown(affichage: Affichage, ids: ReadonlyArray<ElementId | 'tout'>, isVisible: boolean): Affichage {
  const next = { ...affichage }
  for (const id of ids) {
    const targets = id === 'tout' ? ELEMENTS.map(element => element.id) : [id]
    for (const target of targets) next[target] = isVisible
  }
  return next
}

/** L'état de chaque élément, pour /conso affichage. */
export function affichageText(affichage: Affichage): string {
  const lines = ['Affichage de Conso Claude :']
  for (const where of WHERES) {
    lines.push('', `${WHERE_LABELS[where]} :`)
    for (const element of ELEMENTS.filter(e => e.where === where)) {
      lines.push(`  ${isShown(affichage, element.id) ? '☑' : '☐'} ${element.id} · ${element.label}`)
    }
  }
  lines.push('', '/conso afficher <élément…> ou /conso masquer <élément…> (ou « tout ») ; le bouton Affichage du panneau fait pareil.')
  return lines.join('\n')
}
