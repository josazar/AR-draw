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
| Suivi de la main | Où se trouve le bout du doigt à l'écran, et le pincement | **MediaPipe HandLandmarker** |
| Rendu | Les tubes | **three.js 0.183** (`TubeGeometry`) |

Le principe qui fait tenir l'ensemble, dans `src/app.js` :

> MediaPipe donne un point **2D** sur l'écran. On lance un rayon depuis la caméra à travers ce
> point, et on place le point du tube à une certaine distance le long de ce rayon. Comme la
> position de la caméra est exprimée dans le repère monde du SLAM, le point obtenu est **lui aussi
> dans le repère monde**. C'est ce qui fait que le tube reste en place quand le téléphone bouge.

La profondeur vient de la **taille apparente des articulations** : une main qui paraît petite est
loin. On peut basculer en profondeur fixe avec le bouton *Prof. fixe*.

### Pourquoi pas AR.js ni WebXR

- **AR.js** ne fait ni suivi de main ni SLAM. Son mode géolocalisé repose sur le GPS, précis à
  5–15 m — inutilisable pour dessiner au centimètre.
- **WebXR** n'est pas disponible dans Safari sur iPhone, donc pas de `immersive-ar` natif.
- **8th Wall** fait le SLAM en vision par ordinateur, dans le navigateur. C'est la seule brique qui
  résout le problème sur iOS.

### Sur la licence 8th Wall

La plateforme hébergée 8th Wall a fermé le **28 février 2026**. Il n'y a donc plus de compte, plus
de Cloud Editor et **plus de clé d'application** — et surtout, **plus rien à payer ni à créer**.
Le framework est passé en MIT, et le moteur, **SLAM inclus**, est distribué comme binaire sous
licence d'usage limité, chargé ici depuis jsDelivr :

```
https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr.js
```

Aucune authentification n'est requise à l'exécution. Le hand tracking n'est **pas** dans ce
binaire, d'où MediaPipe. Les conditions du binaire sont dans `LICENSE` du paquet npm
`@8thwall/engine-binary` ; à relire avant tout usage commercial.

## Lancer le projet

```bash
npm install
npm run serve
```

Le premier build télécharge le modèle de main (~7,8 Mo) dans `public/models/` et copie le runtime
WASM de MediaPipe dans `public/mediapipe-wasm/`. Les deux sont servis depuis votre propre origine,
donc pas de dépendance CDN à l'exécution et pas de risque de désynchronisation de versions.

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

### Déployer sur GitHub Pages

Le workflow `.github/workflows/deploy.yml` construit et publie à chaque push. **Il faut l'activer
une fois** : *Settings → Pages → Source: GitHub Actions*. Pages sert en HTTPS, donc la caméra
fonctionne directement depuis l'iPhone.

## Utilisation

| Bouton | Effet |
|---|---|
| **Annuler** | Supprime le dernier tube |
| **Effacer** | Vide la scène |
| **Couleur** | Couleur du prochain tube |
| **Prof. auto / fixe** | Profondeur estimée depuis la taille de la main, ou figée à 45 cm |
| **Calibrer** | Corrige l'alignement main/écran (voir ci-dessous) |
| **Debug** | Affiche le squelette détecté et les valeurs en direct |

### Calibrer — à faire au premier lancement

L'image de la caméra n'a pas la même orientation que l'écran, et la combinaison exacte (rotation
+ retournement vertical) dépend du téléphone. Je n'ai pas pu la déterminer depuis un conteneur
sans iPhone, donc elle est réglable :

1. Appuyer sur **Debug** — le squelette de la main s'affiche.
2. Si le squelette ne se superpose pas à votre vraie main, appuyer sur **Calibrer** pour passer à
   l'orientation suivante (8 au total).
3. Dès que le squelette suit la main, c'est bon. **Le réglage est mémorisé** (`localStorage`).

Tant que la calibration est fausse, les tubes apparaîtront au mauvais endroit.

## Réglages

Tout est dans [`src/config.js`](src/config.js) :

- `pinchCloseRatio` / `pinchOpenRatio` — sensibilité du pincement (deux seuils = hystérésis, pour
  éviter que le trait clignote à la limite)
- `depthCalibration` — étalonnage de la profondeur ; augmenter éloigne les tubes
- `positionSmoothing` — lissage du doigt ; MediaPipe est bruité, sans ça le tube ressemble à du
  fil barbelé
- `tubeRadius`, `palette` — apparence
- `cameraMaxDimension`, `detectEveryNFrames` — performance ; passer `detectEveryNFrames` à `2` si
  ça rame

## Tests

Deux niveaux, tous deux exécutables sans téléphone.

### 1. Smoke + unitaire — moteur simulé

```bash
npm i -D playwright && npx playwright install chromium   # une fois
npm run serve                                            # dans un autre terminal
npm run smoke -- http://127.0.0.1:5173/
```

20 assertions : câblage du pipeline, chargement réel de MediaPipe, invariance d'échelle du
pincement, bijectivité des 8 calibrations, construction et cycle de vie des tubes. Le moteur 8th
Wall est stubbé (et bloqué au niveau réseau, pour que le résultat ne dépende pas de sa
disponibilité), donc aucune caméra n'est nécessaire.

### 2. Intégration — vrai moteur, caméra factice

Celui-ci lance **toute** l'application : vrai moteur 8th Wall, vrai SLAM, vrai MediaPipe. Seule la
caméra est simulée, via le périphérique de capture factice de Chromium.

```bash
npm i -D playwright @8thwall/engine-binary @8thwall/xrextras @8thwall/landing-page
npx playwright install chromium

npm run vendor:engine                          # sert le moteur depuis notre origine
node test/make-fake-camera.mjs /tmp/fake.y4m   # damier animé
npm run serve                                  # dans un autre terminal
npm run live -- http://127.0.0.1:5173/ /tmp/fake.y4m live.png
```

Il affiche l'état interne seconde par seconde (frames, main détectée, pincements, profondeur,
position caméra) et produit une capture d'écran. **C'est ce test qui a trouvé le bug le plus
sérieux du projet** : `camerapixelarray` est publié sur `processGpuResult`, pas
`processCpuResult` — le suivi de main ne recevait aucune image.

Deux détails qui coûtent du temps si on ne les connaît pas :

- Il faut **émuler un mobile** (`devices['iPhone 13']`), sinon la *LandingPage* de 8th Wall
  détecte un navigateur desktop et remplace l'app par un écran « scannez ce QR code ».
- Le moteur doit être servi **depuis la même origine** (`npm run vendor:engine`) ; `.env.local`
  bascule les `<script>` du CDN vers `public/vendor/`. Supprimer ce fichier pour revenir au CDN.

#### Tester le dessin pour de vrai

Le damier ne contient pas de main, donc `framesWithHand` reste à 0. Pour exercer la chaîne
complète pincement → tube, filmez votre propre main en train de pincer et convertissez le clip
(le y4m n'est pas compressé, restez court) :

```bash
ffmpeg -i main.mov -t 10 -s 640x480 -pix_fmt yuv420p /tmp/main.y4m
npm run live -- http://127.0.0.1:5173/ /tmp/main.y4m live.png
```

`framesWithHand`, `pinchEvents` et `strokes` doivent alors monter.

### Ce que rien de tout ça ne remplace

Un vrai iPhone reste nécessaire pour : la **qualité du SLAM** (une vidéo synthétique n'a pas de
parallaxe, la caméra ne bouge donc pas dans la scène), le **bon état de calibration**, la
**fluidité réelle** (le WebGL logiciel en headless tourne à ~2 fps, non représentatif) et
l'**ergonomie du geste**.

## Limites connues

- **Non testé sur appareil.** Développé et testé en conteneur sans caméra ; la calibration est
  quasi certainement à ajuster au premier lancement.
- **Pas de persistance.** Les dessins vivent en mémoire et disparaissent au rechargement. Les
  ancrer sur un lieu et les retrouver plus tard demanderait un VPS — Niantic Lightship n'est
  justement **pas** inclus dans le binaire libre.
- **Dérive du SLAM.** Sur de longues sessions ou face à un mur uni, le suivi dérive et les tubes
  peuvent glisser.
- **Une seule main** suivie (`numHands: 1`), volontairement, pour le coût CPU.
