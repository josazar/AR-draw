# AR Draw — dessin spatial au doigt

Application web de réalité augmentée : on filme avec le téléphone, on **pince le pouce et
l'index**, et un **tube 3D** se construit dans l'espace en suivant le doigt. On desserre, le tube
se ferme. Les tubes restent **ancrés dans la pièce** : on peut baisser le téléphone, se déplacer,
revenir, le dessin est toujours là.

Fonctionne dans Safari sur iPhone, sans application à installer.

## Comment ça marche

Trois briques, parce qu'aucune ne fait le travail seule :

| Brique | Rôle | Technologie |
|---|---|---|
| Suivi du monde (SLAM) | Où se trouve le téléphone dans la pièce, à 6 degrés de liberté | **8th Wall engine binary** |
| Rendu | Les tubes | **three.js 0.183** (`TubeGeometry`) |

Le principe qui fait tenir l'ensemble, dans `src/app.js` :

> Le pinceau se tient à une distance fixe droit devant l'objectif. On calcule sa position en
> lançant un rayon depuis la caméra suivie par le SLAM, et comme la pose de cette caméra est
> exprimée dans le repère monde, le point obtenu l'est aussi. **Déplacer le téléphone déplace donc
> le pinceau à travers la pièce** — et le tube reste là où on l'a laissé.

### Le suivi de main a été retiré

Une version précédente déclenchait le tracé sur un **pincement pouce-index** détecté par MediaPipe.
C'est parti, et c'était la bonne décision : MediaPipe interprétait de la géométrie de pièce
ordinaire comme une main assez souvent pour que **filmer une pièce se mette à dessiner tout seul**.
Un geste qui se déclenche quand on n'a pas fait de geste est pire que pas de geste du tout.

Le retrait a aussi supprimé un modèle de 7,8 Mo à télécharger, un réseau de neurones par frame, et
le `readPixels` synchrone qui bloquait le GPU pour l'alimenter. Le démarrage est immédiat et il n'y
a plus aucun asset à charger.

### Pourquoi pas AR.js ni WebXR

- **AR.js** ne fait ni suivi de main ni SLAM. Son mode géolocalisé repose sur le GPS, précis à
  5–15 m — inutilisable pour dessiner au centimètre.
- **WebXR** n'est pas disponible dans Safari sur iPhone, donc pas de `immersive-ar` natif.
- **8th Wall** fait le SLAM en vision par ordinateur, dans le navigateur. C'est la seule brique qui
  résout le problème sur iOS.

### Pourquoi le LiDAR de l'iPhone n'est pas utilisable

Un iPhone Pro a bien un LiDAR, et il donnerait une profondeur mesurée au lieu d'estimée. Mais
**aucune API web ne l'expose** :

- WebXR, et donc son extension *Depth Sensing* (la seule API web de profondeur), n'existe pas dans
  Safari sur iOS. Cette extension est de toute façon une implémentation Chrome/Android.
- Aucune autre API navigateur ne donne accès au capteur de profondeur ; `getUserMedia` ne fournit
  que des flux RGB.
- Le moteur 8th Wall fait du SLAM purement visuel-inertiel, sans capteur de profondeur.

Seule une application **native** (ARKit, `ARConfiguration.frameSemantics.sceneDepth`) y accède. Y
passer signifierait quitter le web, donc perdre le « ouvrir un lien, ça marche » qui justifie tout
le reste de l'architecture.

### Sur la licence 8th Wall

La plateforme hébergée 8th Wall a fermé le **28 février 2026**. Il n'y a donc plus de compte, plus
de Cloud Editor et **plus de clé d'application** — et surtout, **plus rien à payer ni à créer**.
Le framework est passé en MIT, et le moteur, **SLAM inclus**, est distribué comme binaire sous
licence d'usage limité, chargé ici depuis jsDelivr :

```
https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr.js
```

Aucune authentification n'est requise à l'exécution.

**L'attribution est obligatoire, et n'est pas désactivable.** Section 1.3.1.2 du *XR Engine License
Agreement* : toute production utilisant le logiciel doit conserver l'identification de Niantic
Spatial comme auteur, un avis de copyright, une référence à l'accord et une référence à l'exclusion
de garantie. Le moteur n'expose aucune option pour retirer son logo, et le faire violerait la
licence. Ces mentions sont réunies dans [`public/NOTICE.txt`](public/NOTICE.txt), accessible depuis
le badge de version déplié.

Le logo « Powered by 8th Wall » appartient à l'écran de **chargement** de XRExtras, pas à
l'application en marche : il disparaît une fois le démarrage terminé. S'il reste affiché, c'est que
le chargement n'aboutit pas.

**Restriction commerciale** (section 1.2) : le logiciel ne peut pas servir dans un produit ou
service à la fois payant **et** dont la valeur découle substantiellement de ses fonctionnalités.
À lire avant d'envisager une monétisation.

## Lancer le projet

```bash
npm install
npm run serve
```

Aucun asset à télécharger : la seule dépendance externe à l'exécution est le moteur 8th Wall, servi
depuis jsDelivr (ou depuis votre propre origine, voir `npm run vendor:engine`).

### Tester sur l'iPhone : le piège HTTPS

**La caméra n'est accessible qu'en contexte sécurisé.** `localhost` compte comme sécurisé sur la
machine elle-même, mais depuis l'iPhone qui tape l'IP locale de votre Mac (`http://192.168.x.x:5173`),
**Safari refusera la caméra**. Deux options :

```bash
# 1. Tunnel HTTPS — le plus rapide pour itérer
npx cloudflared tunnel --url http://localhost:5173
# ou : ngrok http 5173

# 2. Déployer (voir plus bas)
```

Les domaines `*.trycloudflare.com`, `*.ngrok-free.dev` et `*.ngrok.io` sont déjà autorisés dans
`vite.config.js`.

### Déployer sur Netlify (recommandé)

`netlify.toml` est déjà configuré. Côté Netlify, une seule fois :

1. *Add new site → Import an existing project → GitHub*, choisir ce dépôt.
2. Ne rien changer : la commande de build (`npm run build`) et le dossier publié (`dist`) sont lus
   depuis `netlify.toml`.
3. *Site configuration → Build & deploy → Branches and deploy contexts* : ajouter
   `claude/arjs-spatial-drawing-xfwzrz` aux **branch deploys**.

Chaque push produit alors une URL de preview, en HTTPS — donc la caméra fonctionne, et on ouvre
directement l'URL sur l'iPhone.

Ce que `netlify.toml` règle, et qui n'est pas évident :

- `NODE_VERSION = "20"`, parce que Vite 8 ne construit pas avec le Node par défaut de certains
  comptes.
- `Permissions-Policy: camera=(self)`.
- Cache immuable sur le modèle (7,8 Mo) et les WASM, qui ne changent jamais entre deux déploiements.
- **Pas** de `Cross-Origin-Embedder-Policy`. COEP bloque toute sous-ressource sans en-tête CORP —
  dont le moteur 8th Wall sur jsDelivr. L'application ne chargerait plus du tout.

### Déployer sur GitHub Pages (alternative)

Le workflow `.github/workflows/deploy.yml` fait la même chose. **À activer une fois** :
*Settings → Pages → Source: GitHub Actions*. Les deux peuvent coexister sans conflit.

## Utilisation

En haut à gauche, un **badge de version** (`v0.10.0`). Le toucher déplie le commit et la date de
build : c'est ce qui identifie précisément le déploiement qu'on a sous les yeux.

| Bouton | Effet |
|---|---|
| **Annuler** | Supprime le dernier tube |
| **Effacer** | Vide la scène |
| **Couleur** | Couleur du prochain tube |
| **Prof. auto / fixe** | Profondeur métrique déduite de la main, ou figée à 45 cm |
| **Debug** | Affiche le squelette détecté et les valeurs en direct |

### Comment dessiner

Appui long (350 ms) dans le cercle au centre de l'écran, puis **déplacer le téléphone**. Relâcher
ferme le tube.

Le réticule indique l'état : anneau blanc au repos, jaune pendant l'appui, vert pendant le tracé.
Le disque translucide au centre montre **l'épaisseur qu'aura le tube à la distance choisie** — il
grossit quand on rapproche le pinceau, rétrécit quand on l'éloigne.

Le **curseur vertical à droite** règle cette distance, de 15 cm à 2,50 m.

Un appui court ne laisse aucune trace, et un appui hors de la zone centrale, sur un bouton ou sur
le curseur est ignoré.

`touchZoneRadius`, `longPressMs`, `drawDepth` et ses bornes dans `config.js`.

### Il n'y a pas de calibrage

Une version précédente demandait de faire défiler 8 orientations à la main. C'était inutile : le
moteur publie déjà, à chaque frame, le rectangle exact dans lequel il a dessiné la caméra —
`processGpuResult.gltexturerenderer.viewport`, en pixels canvas. L'image est mise à l'échelle pour
couvrir le canvas puis rognée, **jamais pivotée**, et `CameraPixelArray` renvoie cette même image à
l'endroit. La correspondance image → écran est donc une simple homothétie, et elle est juste sur
n'importe quel appareil puisque c'est le moteur lui-même qui fournit le nombre.

Vérifié avec une mire : un bloc clair placé en haut à gauche de la source ressort en haut à gauche
du tableau de pixels, et s'affiche en haut à gauche du canvas, à la position exacte que prédit la
formule.

Pour contrôler que le suivi fonctionne : **Debug** superpose le squelette détecté, avec un cercle
jaune sur le bout de l'index — le point qui dessine réellement. S'il suit votre doigt, tout est
bon.

### Stabilité dans l'espace

Le SLAM monoculaire a une faiblesse structurelle qu'il faut connaître : **la rotation pure est son
pire cas**. Tourner sur place ne produit aucune parallaxe, donc le système ne peut trianguler aucun
point nouveau ; la carte se dégrade, et au retour il relocalise — souvent avec un repère décalé.
D'où des traits qui ne sont plus au même endroit après un aller-retour angulaire.

Trois mesures dans l'application :

1. **Le tracé se met en pause** dès que `trackingStatus` quitte `NORMAL`. Les points enregistrés
   pendant une relocalisation seraient placés contre une pose sur le point d'être corrigée, donc
   forcément au mauvais endroit. Le trait reprend là où il s'était arrêté.
2. **Les sauts de repère sont compensés.** Une relocalisation se manifeste par une discontinuité
   sur **une seule frame** — le mouvement réel, lui, est continu. Un pic par rapport à la médiane
   des dernières frames est donc discriminant. Quand il est détecté, la transformation
   `B·inv(A)` est appliquée à l'ensemble du dessin, qui reste ainsi là où on l'a laissé.
3. **Les causes sont nommées à l'écran** plutôt que codées : « surface trop uniforme », « mouvement
   trop rapide », « lumière insuffisante » — c'est `trackingReason` traduit en action.

Compenser, c'est préférer la continuité visuelle à l'estimation corrigée du SLAM. C'est le bon
arbitrage ici : le dessin est le résultat, et le voir se téléporter est pire que le voir à quelques
centimètres près.

**Ce qui aide vraiment, côté usage** : translater plutôt que pivoter. Un pas de côté donne de la
parallaxe, une rotation sur place n'en donne aucune. Viser des surfaces texturées plutôt qu'un mur
uni, et éviter les mouvements brusques.

**Ce qui manque, et qu'on ne peut pas ajouter** : des ancres persistantes. Retrouver un dessin au
même endroit après avoir quitté la page demanderait un VPS — Lightship, justement absent du binaire
libre.

### Diagnostiquer un tremblement

Le bandeau en mode Debug affiche `slam <état> <n>mm/f`. Ces deux valeurs séparent deux causes qu'on
confond facilement :

- **`slam LIMITED`, ou plusieurs mm/frame téléphone immobile** → c'est la **pose caméra** qui
  bouge. Tout tremble alors, y compris les tubes déjà terminés. Causes : surface uniforme sans
  relief, lumière faible, mouvement trop rapide. `trackingReason` précise laquelle.
- **`slam NORMAL`, jitter proche de zéro** → le suivi tient. Un tracé qui ondule encore relève du
  lissage : `filterWorld` et `smoothingPasses`.

Un tube déjà posé est de la géométrie statique : s'il tremble, c'est forcément la pose caméra.

### Échelle : stable plutôt que juste

`XrController.configure({scale})` accepte deux modes, et le choix n'est pas celui qu'on croit.

- **`'responsive'` (utilisé ici)** — l'échelle du monde est **figée à l'initialisation**, déduite
  d'une hauteur de caméra supposée. Métriquement approximatif : téléphone tenu à 1 m au lieu de
  1,4 m, les unités sont fausses de 40 %. Mais **le contenu ne change jamais de taille**.
- **`'absolute'`** — échelle métrique brute du VIO monoculaire. Honnête, mais l'estimation
  **s'affine à mesure que l'appareil se déplace**, et à chaque révision tout ce qui est déjà dessiné
  change de taille. Sortir d'une pièce et y revenir déclenche précisément ce recalcul.

Un dessin qui rétrécit est pire qu'un dessin faux de 20 % : la stabilité l'emporte. `?scale=absolute`
permet de comparer les deux sur un vrai appareil — le paramètre doit être lu avant `XR8.run()`, le
moteur refusant tout changement d'échelle ensuite.

`depthScale` dans `config.js` corrige un écart systématique de taille sans toucher au mode.

### Lissage du tube

Les points enregistrés sont le trajet du doigt, et même filtrés ils gardent de petits coudes. Un
tube balayé le long d'une ligne coudée n'est pas seulement anguleux : les repères de `TubeGeometry`
pivotent brutalement dans le coude, ce qui **vrille la surface** et peut la retourner — d'où
l'impression de voir au travers.

La ligne centrale passe donc par un **lissage laplacien** avant le balayage
([`src/smoothing.js`](src/smoothing.js)) : à chaque passe, chaque point intérieur se déplace d'une
fraction `lambda` vers le milieu de ses voisins. Les extrémités sont épinglées, donc un tracé
commence et finit exactement là où le doigt était.

Le lissage part **toujours** des points bruts, jamais sur place : lisser en place relisserait à
chaque reconstruction un trajet déjà lissé, et le tracé s'aplatirait progressivement pendant qu'on
dessine. Un test verrouille ce point.

Le matériau est en `DoubleSide`. Une face avant seule laisse voir à travers dès que la caméra se
retrouve **dans** le tube — ce qui arrive vite avec un tube de 7 cm dessiné à 30 cm — ou là où le
balayage s'est localement inversé. Dessiner les faces arrière ne coûte rien sur si peu de géométrie
et supprime toute cette classe de trou.

## Réglages

Tout est dans [`src/config.js`](src/config.js) :

- `longPressMs` / `touchZoneRadius` — déclenchement du tracé
- `drawDepth`, `drawDepthMin`, `drawDepthMax` — distance initiale et bornes du curseur
- `filterWorld` — filtre One Euro sur la position du pinceau. `minCutoff` règle la stabilité quand
  le téléphone est immobile (l'augmenter réduit la latence) ; `beta` règle la vitesse à laquelle le
  filtre s'efface quand le téléphone bouge (l'augmenter réduit le retard sur les gestes rapides)
- `tubeRadius` (3,6 cm), `palette` — apparence
- `smoothingPasses` / `smoothingLambda` — plus de passes donne un tracé plus rond, mais plus court :
  les coins sont rognés
- `tubeRadialSegments` (12) / `tubeSegmentsPerPoint` (4) — finesse de la géométrie

### Performance

Ce que fait l'application par frame : SLAM, un réseau de neurones, et une reconstruction de
géométrie. Les leviers, par ordre d'impact :

- `detectEveryNFrames` — à `0` (défaut), la cadence d'inférence **s'adapte toute seule** au temps
  mesuré : 1 frame sur 1 si l'inférence tient sous `detectBudgetMs`, sinon 1 sur 2, puis 1 sur 3.
  Mettre `1`/`2`/`3` pour la figer.
- `rebuildIntervalMs` — la reconstruction du tube est l'opération la plus coûteuse pendant le
  dessin. Elle est limitée à ~16 fois par seconde ; le bouchon de tête, lui, suit le doigt à chaque
  frame, donc la pointe ne paraît jamais figée.
- `cameraMaxDimension` — 256. Le détecteur redimensionne à 192×192 en interne, donc monter plus
  haut ne sert qu'aux mains lointaines, et chaque pixel se paie deux fois : à la relecture GPU puis
  à l'inférence.
- `tubeRadialSegments` (6) et `tubeSegmentsPerPoint` (2). Les tubes utilisent `MeshLambertMaterial`
  et non `MeshStandardMaterial` : le PBR ne se voit pas sur un tube uni et coûte du fill rate.

### Pourquoi pas WebGPU

Vérifié dans les sources plutôt que supposé :

- Le binaire 8th Wall ne contient **aucune** occurrence de `webgpu` ; il crée des contextes
  `webgl`/`webgl2` et y dessine le flux caméra. Pour composer les tubes par-dessus, three.js doit
  rendre dans **ce** contexte. Un `WebGPURenderer` vivrait dans un contexte séparé, et composer
  deux contextes impose une recopie par frame — plus lent, pas plus rapide.
- `@mediapipe/tasks-vision` n'expose que le délégué `"GPU"`, qui est WebGL. Aucun chemin WebGPU.

Et surtout, ça viserait à côté : le coût dominant est l'inférence du réseau de neurones, pas le
rendu de quelques tubes. Les leviers ci-dessus s'attaquent au vrai goulot.

## Tests

Deux niveaux, tous deux exécutables sans téléphone.

### 1. Smoke + unitaire — moteur simulé

```bash
npm i -D playwright && npx playwright install chromium   # une fois
npm run serve                                            # dans un autre terminal
npm run smoke -- http://127.0.0.1:5173/
```

42 assertions : câblage du pipeline, verrouillage de l'échelle SLAM, réglage de la distance par le
curseur et sa prévisualisation, déclenchement du tracé (appui long, appui court ignoré, hors zone
ignoré, curseur ignoré), tracé pendant un déplacement simulé du téléphone, comportement du filtre
One Euro, lissage de la ligne centrale, construction et cycle de vie des tubes. Le moteur 8th
Wall est stubbé (et bloqué au niveau réseau, pour que le résultat ne dépende pas de sa
disponibilité), donc aucune caméra n'est nécessaire.

### 2. Intégration — vrai moteur, caméra factice

Celui-ci lance **toute** l'application : vrai moteur 8th Wall, vrai SLAM. Seule la caméra est
simulée, via le périphérique de capture factice de Chromium.

```bash
npm i -D playwright @8thwall/engine-binary @8thwall/xrextras @8thwall/landing-page
npx playwright install chromium

npm run vendor:engine                          # sert le moteur depuis notre origine
node test/make-fake-camera.mjs /tmp/fake.y4m   # damier animé
npm run serve                                  # dans un autre terminal
npm run live -- http://127.0.0.1:5173/ /tmp/fake.y4m live.png
```

Il affiche l'état interne seconde par seconde (frames, état du SLAM, distance, position caméra) et
produit une capture d'écran. **C'est ce test qui a trouvé le bug le plus
sérieux du projet** : `camerapixelarray` est publié sur `processGpuResult`, pas
`processCpuResult` — le suivi de main ne recevait aucune image.

Deux détails qui coûtent du temps si on ne les connaît pas :

- Il faut **émuler un mobile** (`devices['iPhone 13']`), sinon la *LandingPage* de 8th Wall
  détecte un navigateur desktop et remplace l'app par un écran « scannez ce QR code ».
- Le moteur doit être servi **depuis la même origine** (`npm run vendor:engine`) ; `.env.local`
  bascule les `<script>` du CDN vers `public/vendor/`. Supprimer ce fichier pour revenir au CDN.

### Ce que rien de tout ça ne remplace

Un vrai iPhone reste nécessaire pour : la **qualité du SLAM** (une vidéo synthétique n'a pas de
parallaxe, la caméra ne bouge donc pas dans la scène), la **fluidité réelle** (le WebGL logiciel en
headless met plus d'une seconde par inférence, totalement non représentatif) et l'**ergonomie du
geste**.

## Limites connues

- **Pas de persistance.** Les dessins vivent en mémoire et disparaissent au rechargement. Les
  ancrer sur un lieu et les retrouver plus tard demanderait un VPS — Niantic Lightship n'est
  justement **pas** inclus dans le binaire libre.
- **Dérive du SLAM.** Sur de longues sessions ou face à un mur uni, le suivi dérive et les tubes
  peuvent glisser.
- **Une seule main** suivie (`numHands: 1`), volontairement, pour le coût CPU.
