# AR Jewelry Try-On

Mobile-first Web AR prototype for bracelet try-on. The page processes camera
frames locally in the browser, tracks the wrist with MediaPipe, and renders a
Three.js bracelet with automatic sizing, orientation following, and depth
occlusion. The calibration panel includes an arm-axis A/B switch: the existing
Hand-only estimate, or a Pose Lite elbow-to-wrist axis with Hand landmarks used
only for twist around that axis. In Pose mode, that twist remains responsive in
side views because its confidence comes from Hand tracking rather than the
projected palm width.

The fitting controls use the bracelet's inner diameter, support an elliptical
wrist cross-section, and keep the invisible occlusion proxy on the same aspect
ratio. Quaternion twist smoothing can be disabled independently for live A/B
comparison without changing position tracking.

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

For the Pose arm-axis test, keep the tracked hand, wrist, and same-side elbow in
frame. If Pose loses that elbow/wrist pair, the bracelet fades out instead of
silently falling back to the Hand-only axis. Segmentation is disabled.

Calibration mode overlays the mapped Pose elbow-to-wrist line (red), rendered
Torus local-normal line (green), and sensor-derived world-down line (blue).
Screen-orientation and front-camera mirror conversions are applied before the
debug comparison. `Forearm vs Gravity angle` and
`Bracelet vs Forearm angle` are unoriented-axis errors, so parallel and
anti-parallel directions both read 0 degrees. Gravity is diagnostic-only and
does not alter the bracelet pose or physics.

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
