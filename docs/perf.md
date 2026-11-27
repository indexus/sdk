# Mesures de performance

But : dire, métrique par métrique, si une version est **mieux, pareille ou
pire** qu’une référence, sur le chemin nœud → fil → SDK → GPU. Chaque suite
produit le même format de résultat ; un seul comparateur les lit tous.

| Suite | Commande | Mesure | Référence |
|---|---|---|---|
| `core/go` | `core/scripts/perf/run.sh out.json` | encodage `/sets` IXB2, projection de lecture, inventaire, insertions, scellement, trames de connaissance | `core/perf/baseline/go.json` |
| `sdk-js/node` | `node scripts/perf/run.mjs --out out.json` | décodage IXB2, `Space`, `projectRowsCPU`, MOVE par le walk : temps et mémoire allouée | `sdk-js/perf/baseline/node.json` |
| `sdk-js/browser` | `node scripts/perf/browser/build.mjs` puis ouvrir `scripts/perf/browser/dist/perf.html` | noyau cells sur le GPU, rendu `AverageGridLayerWebGPU` sur données synthétiques | à produire sur le Mac |
| `experiences/explore-bench` | `/explore.html?bench=<parcours>` | parcours de caméra réel : première donnée, cadence, octets, requêtes `/sets`, mémoire | à produire sur le Mac |

## Format `indexus-perf/1`

Un fichier JSON par exécution :

```json
{
  "schema": "indexus-perf/1",
  "suite": "sdk-js/node",
  "commit": "c3942e6",
  "branch": "master",
  "date": "2026-11-13T10:57:50Z",
  "env": {"machine": "…", "os": "…", "cpu": "…", "runtime": "node v22.23.4"},
  "metrics": [
    {"name": "wire.ixb2.decode/10000", "unit": "ms", "value": 0.0083,
     "samples": [0.0081, 0.0083, 0.0084], "better": "lower", "noise": 2.4}
  ]
}
```

- `commit` : commit mesuré, suffixé `-dirty` si le code mesuré (`src/` du SDK,
  hors `scripts/perf` et `perf/` pour core) diffère du commit. Les pages
  navigateur prennent celui de leur construction ; Explore le lit dans `&commit=`.
- `env` : de quoi reconnaître la machine. `env.machine` vaut `PERF_MACHINE`
  (Node, Go) ou `&machine=` (navigateur), sinon le nom d’hôte. Le comparateur
  prévient quand `machine`, `cpu` ou `gpu` diffèrent : les temps de deux
  machines ne se comparent pas.
- `metrics[].name` : stable d’une version à l’autre ; la taille de l’entrée est
  dans le nom (`/10000`). Un même nom peut porter plusieurs unités (temps et
  mémoire) : la clé est `(name, unit)`.
- `value` : médiane des `samples`. `samples` : une valeur par répétition
  (absent pour une valeur exacte, comme une taille de corps).
- `better` : `lower` ou `higher`.
- `noise` : dispersion des échantillons en % de la médiane, soit le plus grand
  de 1,4826·MAD et IQR/1,349 (deux estimations robustes d’un écart type : un
  GC isolé ne l’élargit pas, des échantillons qui sautent entre deux niveaux si).
  Informatif : le comparateur la recalcule depuis `samples`.

## Comparer

```
node sdk-js/scripts/perf/compare.mjs reference.json actuel.json [--threshold 10]
```

Node, sans dépendance. Affiche un tableau : métrique, unité, référence et
actuel (médiane ± dispersion), écart en %, bande de bruit, verdict.

Pour chaque métrique, l’écart est `(actuel − référence) / référence`, compté
positivement dans le mauvais sens (`better`). La bande de bruit vaut trois
erreurs types de la différence des médianes :
`3·√(e_ref² + e_act²)`, avec `e = 1,2533·dispersion/√n`.

- **pire** : écart > seuil **et** > bande de bruit ;
- **mieux** : même règle dans l’autre sens ;
- **pareil** : sinon ;
- **absente** / **nouvelle** : la métrique n’est que d’un côté.

Deux valeurs entières qui diffèrent d’au plus une unité sont « pareil » : Go
tronque `allocs/op` et sa part amortie bouge avec `b.N` (5 → 6 n’est pas une
régression).

Code de sortie : 1 si au moins une métrique est « pire », 2 si les fichiers ne
se comparent pas (format, arguments), 0 sinon. Sans échantillons, seule
`noise` (si présente) élargit la bande ; une valeur exacte n’a que le seuil.

La bande ne voit que la dispersion **à l’intérieur** d’une exécution. Sur une
machine dont la charge change entre deux exécutions (un conteneur partagé,
un portable qui chauffe), la dérive entre exécutions la dépasse : relancer la
référence juste avant la mesure, et confirmer un « pire » par une seconde paire.

Tests : `node --test scripts/perf/compare.test.mjs` (hors `npm test`).

## Suites

### `core/go` — `core/scripts/perf/run.sh [out.json]`

`go test -run '^$' -bench … -benchmem -count $PERF_COUNT -benchtime $PERF_BENCHTIME`
sur `indexus` (EncodeSetsBlock IXB2,
ReadProjectionDense, SummaryInventoryPayload, MonitoringZoneCount,
CloneReadSet, CompactSummaryBuild), `internal/storage`
(InventoryPayloadProjection, SnapshotSeal, StoredZoneKeyDecode,
RecordMetricsOpaqueProjection, CausalInsert en variantes `logical-*`) et
`internal/mesh` (KnowledgeFrameCopies/typed). Puis
`go run scripts/perf/benchjson.go` convertit la sortie : ns/op, B/op, allocs/op
et les tailles encodées (`bytes`, `response-bytes`). La sortie brute est gardée
à côté (`out.txt`), lisible par `benchstat`.

- Par défaut `PERF_COUNT=6`, `PERF_BENCHTIME=300ms` (≈ 1 min 30 sur 2 vCPU).
- Écartés : les insertions durables (`durable-*`, fsync : elles mesurent le
  disque) et la référence JSON de KnowledgeFrameCopies.
- Chaîne Go : `go.mod` exige Go 1.26, utilisé tel quel s'il est dans le PATH.
  `INDEXUS_GO_ENV=fichier` désigne un fichier à sourcer avant `go` (une chaîne
  d'outils ou des modules hors ligne). Un Go trop ancien sans ce fichier
  arrête le script avec un message.

### `sdk-js/node` — `node scripts/perf/run.mjs [--out out.json] [--quick]`

Le script se relance avec `--expose-gc --min-semi-space-size=64
--max-semi-space-size=64`. Chaque mesure : échauffement (5 appels et au moins
500 ms, pour que le JIT ait fini), puis 15 échantillons ; un échantillon répète
l’appel jusqu’à ~5 ms. Deux unités par mesure :

- `ms` : temps par appel ;
- `KiB` : mémoire allouée par appel = croissance de `heapUsed + arrayBuffers`
  (`process.memoryUsage`) après un GC forcé, résultats gardés en vie. Borne
  basse si un GC mineur survient pendant l’appel (la jeune génération de 64 Mo
  l’évite pour ces tailles).

Mesures :

- `wire.*` : `decodeBlocks` (IXB2), avec ou sans conversion en éléments, sur
  10 000 lignes en 50 parents ; taille brute et gzip du corps. Fixture et
  encodeur : `scripts/perf/wire-decode.mjs`. Les références antérieures
  contiennent aussi `wire.v1.*`, retirés avec le décodeur v1 : le comparateur
  les signale absents.
- `space.*` : `encode`, `decode`, `xyz` de 10 000 points d’un `Space` géographique.
- `cells.projectRowsCPU/*` : référence CPU du noyau cells, 10 000 et 100 000
  lignes (même tâche que la page navigateur : `scripts/perf/cellsJob.mjs`).
- `move.v2.walk/*`, `move.v2.walk+cpuPack/*` : un MOVE sur des blocs déjà
  lus — le walk du worker, puis le pack (sa référence CPU, `planToInstancesCPU`,
  tient lieu du noyau GPU que Node ne chronomètre pas). Les références
  antérieures contiennent aussi `cube.ingest` et `move.v1.*`, retirés avec le
  pipeline v1 : le comparateur les signale absents.
- `mix.*` : une frame d’un mélange de deux collections (`docs/compose.md`,
  tâche `scripts/perf/mixJob.mjs`, 25 000 points par collection) sur des blocs
  déjà lus. `mix.walk` : les deux walks. `mix.walk+frame-cpu` : plus ce que le
  thread principal paie pour la frame (tampons de plan et uniformes des deux
  packs et du combine). `mix.walk+cpuJoin` : le même résultat calculé sur CPU
  (émulation des noyaux puis jointure par clé de cellule), soit ce que le GPU
  retire au thread principal. La frame GPU elle-même se mesure dans la page
  `scripts/gpu-check/dist/compose-check.html` (`frameMs`).

`--quick` : 5 échantillons, pour vérifier que tout tourne, pas pour comparer.

### `sdk-js/browser` — page autonome

```
node scripts/perf/browser/build.mjs        # → scripts/perf/browser/dist/perf.html
```

Un seul HTML, tout le JavaScript inclus, aucune requête réseau ; il porte le
commit de sa construction (reconstruire avant de mesurer ; `dist/` n’est pas
versionné). L’ouvrir dans Chrome (WebGPU), onglet au premier plan, rien
d’autre qui tourne. Le titre passe à `DONE` (ou `NO-WEBGPU`, `FAIL`) ; le JSON
est dans `<pre id="result">`, le bouton « Copier » le copie.
Paramètres : `?runs=15`, `?machine=mac-m2`.

- `gpu.cells.submit/n` : un appel `projectRowsGPU` (envoi des colonnes,
  encodage, soumission), côté CPU ; `gpu.cells.done/n` : jusqu’à
  `onSubmittedWorkDone`. n = 10 000, 100 000, 1 000 000.
- `browser.cells.projectRowsCPU/n` : la référence CPU dans le moteur du navigateur.
- `gpu.heatmap.*/n` : `AverageGridLayerWebGPU` réel, sans carte MapLibre — une
  fausse carte fournit `transform.mercatorMatrix` (vue orthographique de la
  France), un contrôleur minimal fournit un paquet synthétique stable de n
  instances (grille régulière, profondeur adaptée, pas de transition), le
  composite WebGL2 se fait dans un canvas détaché de 1280×720, masque coupé.
  `frame-upload` : image avec envoi d’un nouveau paquet ; `frame` : caméra
  déplacée, paquet déjà sur le GPU, jusqu’à `onSubmittedWorkDone` + `gl.finish` ;
  `frame-cpu` : la partie CPU de `render()` ; `frame-idle` : caméra immobile
  (chemin qui ne fait que recopier la dernière image).

Limites : pas de `timestamp-query`, les temps GPU incluent l’ordonnancement de
la file ; le bundle contient le code de MapLibre (importé par `gpu/mask.js`)
mais n’en crée aucune carte.

### `experiences/explore-bench` — `/explore.html?bench=<parcours>`

Parcours dans `experiences/src/experiences/explore/diagnostics/benchPaths.js` :
`france` (météo), `realestate` (DVF 2020, ajoute `data=realestate`), `anglet`
(3D, ajoute `scene=anglet`). Positions absolues : changer un parcours casse la
comparaison, en ajouter un sous un autre nom.

Une page chargée = une exécution : attente de la première vue stable (plus de
réponse réseau depuis 1 s, carte chargée, 30 s au plus), puis chaque étape du
parcours (`easeTo`), chacune suivie de la même attente. La page se recharge
jusqu’à `&runs=N` (3 par défaut), puis affiche le JSON (chaque exécution est un
échantillon), le copie, le journalise et le met dans `window.__INDEXUS_BENCH__`.
`env.settleTimedOut` signale une attente arrivée à 30 s.

Métriques (`explore.<parcours>.*`) : `first-data` (de la navigation à l’image
qui suit la première réponse `/sets` : borne basse, le décodage et l’envoi au
GPU viennent après), `first-settled`, `path` (durée du parcours avec ses
attentes), `frame.p50/p95/p99` et `frame.over50ms` (intervalles
`requestAnimationFrame` pendant les mouvements), `sets.requests`,
`sets.transfer` et `sets.body` (octets sur le fil et corps encodé),
`network.requests`, `network.transfer`, `js.heap` (Chrome seulement).

Resource Timing est propre à chaque contexte et la plupart des lectures `/sets`
partent des workers : avec `?bench`, et seulement avec, Explore démarre ses
workers par un amorçage qui renvoie leurs entrées sur un `BroadcastChannel`.
Les workers internes de MapLibre (URL `blob:`) ne passent pas par l’amorçage :
les tuiles du fond de carte qu’ils chargent manquent à `network.*`.
Sans le paramètre, rien de ce code n’est chargé hormis l’interrupteur
`diagnostics/bench.js` (quelques lignes inertes). Les octets d’une réponse
servie par le cache HTTP valent 0 en `transfer` : comparer à cache égal
(fenêtre privée neuve, ou DevTools fermés).

`?bench` n’active pas `?trace` : la trace de session a son propre coût.

### Dashboard (`AggregateHeatmap`) : non branché

Le même banc s’y brancherait, mais pas « facilement » : la carte est créée dans
le composant React (`mapRef`) et n’est atteignable de l’extérieur que par un
crochet ajouté au composant ; le worker de chaleur est créé par
`useHeatmap` du SDK. Il faudrait : (1) un `src/bench.js` importé en premier par l’entrée du
dashboard, qui installe la même sonde de workers sous `?bench` ; (2) dans
`AggregateHeatmap`, sous `?bench` seulement, exposer la carte une fois `load`
reçu ; (3) un parcours DVF (comme `realestate`). Le coureur d’Explore
(`benchRun.js`) devrait alors vivre à un seul endroit partagé par les deux
applications, ce qui demande de décider où (le SDK n’exporte pas d’outillage
de mesure aujourd’hui).

## Références

| Suite | Fichier | Machine | Commit |
|---|---|---|---|
| `core/go` | `core/perf/baseline/go.json` (+ `go.txt`) | conteneur Linux de développement, 2 vCPU Xeon partagés, Go 1.24.7 | `29cc477` (13 novembre 2026) |
| `sdk-js/node` | `sdk-js/perf/baseline/node.json` | idem, Node 22.23 | `c3942e6` (13 novembre 2026) |

Ces références valent pour ce conteneur, lent et partagé : deux exécutions
du même code y diffèrent couramment de 20 à 50 % sur les temps, pas sur les
tailles ni les allocations Go. Elles servent à vérifier que les suites
tournent et, avec `--threshold 40` et une référence relancée juste avant, à
repérer une régression grossière. Une référence fiable se refait sur une
machine stable (le Mac), au commit de base voulu :

```
cd core   && PERF_MACHINE=mac scripts/perf/run.sh perf/baseline/go.json
cd sdk-js && PERF_MACHINE=mac node scripts/perf/run.mjs --out perf/baseline/node.json
```

puis, à chaque changement :

```
cd core   && PERF_MACHINE=mac scripts/perf/run.sh /tmp/go.json   && node ../sdk-js/scripts/perf/compare.mjs perf/baseline/go.json /tmp/go.json
cd sdk-js && PERF_MACHINE=mac node scripts/perf/run.mjs --out /tmp/node.json && node scripts/perf/compare.mjs perf/baseline/node.json /tmp/node.json
```

Navigateur, sur le Mac, même procédure pour la référence et pour chaque mesure :

1. Secteur branché, applications lourdes fermées, Chrome à jour, une seule fenêtre.
2. GPU : `node scripts/perf/browser/build.mjs`, ouvrir `dist/perf.html?machine=mac`
   trois fois de suite ; garder la troisième (ou toutes, pour juger du bruit).
   « Copier », coller dans `sdk-js/perf/baseline/browser.json`.
3. Explore : `npm run dev` dans experiences (nœud Indexus local ou passerelle
   habituelle), puis
   `http://127.0.0.1:5174/explore.html?bench=france&runs=5&machine=mac&commit=$(git -C ../sdk-js rev-parse --short HEAD)`,
   de même `bench=realestate` et `bench=anglet`. Garder la fenêtre au premier
   plan pendant les rechargements. Coller dans
   `experiences/perf/baseline/explore-<parcours>.json`. La référence n’a de
   sens qu’avec les mêmes données servies par le même nœud.

## Bonnes pratiques

- Mesurer avant et après sur la même machine, dans le même état ; relancer
  la référence si la machine a changé (OS, navigateur, Go, Node).
- Un « pire » isolé à la limite du bruit : relancer les deux côtés avant de
  conclure. Un « pire » sur `B/op`, `allocs/op` ou `KiB` est rarement du bruit.
- Une amélioration voulue se montre : joindre la sortie du comparateur au commit.
