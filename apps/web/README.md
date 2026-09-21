# AR Jewelry Try-On

Mobile-first Web AR prototype for bracelet try-on. The page processes camera
frames locally in the browser, tracks the wrist with MediaPipe, and renders a
Three.js bracelet with automatic sizing, orientation following, and depth
occlusion.

## Requirements

- Node.js 20 or newer
- A browser with camera support
- HTTPS for real mobile camera testing; `localhost` is allowed for development

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Camera access starts only
after the user clicks the camera button. No camera video is uploaded by this
prototype.

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## Scope

The current release validates the core flow: open the page, authorize the
camera, try on a bracelet, capture or share the result, and open a purchase
link. Merchant APIs, persistent analytics, payment, and production asset
licensing are tracked in the repository-level `ROADMAP.md` and `TODO.md`.

Release preparation follows the repository-level `CHANGELOG.md` and the
QuantTide DevOps lifecycle. When `qtcloud-devops` is available, use
`qtcloud-devops release audit` and `qtcloud-devops release publish` as the
release entrypoints. In this repository, pushing a commit with a new package
version to `main` triggers `.github/workflows/release.yml`, which creates the
matching `ar/vX.Y.Z` tag and GitHub Release after all checks pass.
