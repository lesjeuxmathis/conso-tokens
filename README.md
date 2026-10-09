# Conso Claude (`conso-tokens`)

Un mod pour Claude Code (terminal et onglet Code de l’app de bureau) qui montre **en direct** :

- **ton forfait** : le % utilisé de la fenêtre de 5 h, de la semaine (et du crédit s’il y en a), avec le compte à rebours et l’heure de réinitialisation, plus une alerte à 80, 90 et 100 % ;
- **une estimation de la taille de ta fenêtre en tokens**, déduite de ce que tu consommes (Anthropic ne publie pas de quota en tokens, seulement des %) ;
- **les tokens de la session**, requête par requête (entrée, sortie, cache lu, cache écrit), et le remplissage du contexte ;
- **le prix**, calculé avec la grille officielle d’Anthropic (platform.claude.com), relue toutes les 6 h, en dollars, en euros (taux officiel de la BCE) ou les deux.

Avec un abonnement (Pro, Max), le prix affiché est l’équivalent au tarif de l’API, pas ce qui t’est facturé.

## Installer

Dans un **terminal** (PowerShell, cmd, bash…), pas dans l’onglet Code de l’app de bureau :

```bash
claude plugin marketplace add lesjeuxmathis/conso-tokens
```

```bash
claude plugin install conso-tokens@conso-tokens
```

Le mod se charge ensuite dans chaque nouvelle conversation, dans le terminal comme dans l’app de bureau. Une conversation déjà ouverte ne le voit qu’après un redémarrage.

Testé avec Claude Code 2.1.293. Le mod utilise les « function hooks » de Claude Code, une API en accès anticipé qui peut changer d’une version à l’autre.

## Utiliser

| Commande | Ce qu’elle fait |
| --- | --- |
| `/conso` | Ouvre le panneau (il s’ouvre aussi tout seul au démarrage) |
| `/conso affichage` | Montre ce qui est affiché ou masqué |
| `/conso masquer prix ligne-tokens` | Masque des éléments (ou `tout`) |
| `/conso afficher tout` | Réaffiche des éléments |
| `/conso devise eur` | Prix en `usd`, `eur` ou `les-deux` |
| `/conso actualiser` | Relit les limites et la grille de prix |
| `/conso-session` | Consommation exacte de la session en cours |
| `/conso-session liste` | Les 12 dernières sessions |
| `/conso-session <début de l’id>` | Consommation exacte d’une autre session |

Le panneau a aussi un bouton **Affichage** pour cocher ce que tu veux voir, dans le panneau et dans la ligne d’état.

Options à l’installation (facultatives) : `--config prix=false`, `--config devise=eur`, `--config ouvrirAuDemarrage=false`.

## Ce que le mod lit et envoie

- Il lit les chiffres que Claude Code lui donne (tokens, limites, coût) et, pour `/conso-session`, les journaux de session de ton PC (`~/.claude/projects`). Rien de tout ça ne quitte ton PC.
- Il ne télécharge que deux pages publiques : la grille de prix d’Anthropic et le taux de change du jour de la BCE.

## Mettre à jour

```bash
claude plugin marketplace update conso-tokens
```

```bash
claude plugin update conso-tokens@conso-tokens
```

La nouvelle version s’applique aux conversations ouvertes après.

## Désinstaller

```bash
claude plugin uninstall conso-tokens@conso-tokens
```

## Licence

MIT, voir [LICENSE](LICENSE).
