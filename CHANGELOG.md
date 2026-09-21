# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses semantic versioning.

## [Unreleased]

## [0.2.0] - 2026-09-21

### Added

- Added per-product fitting configuration with automatic-size enablement,
  automatic fit ratio, wrist-to-palm ratio, scale bounds, manual scale, and
  anchor offset.
- Added automatic/manual sizing override controls in the calibration panel.
- Added browser-local persistence for fitting configuration across reloads.
- Added a Worker-to-main-thread hand tracking fallback for browsers that cannot
  create or transfer resized video `ImageBitmap` frames.
- Added user-visible retry guidance for camera, model-loading, network, and
  tracking-runtime failures.
- Added Vitest coverage for hand selection, wrist pose anchoring, pose
  continuity, scale fitting, and wrist-rotation size locking.
- Added privacy-preserving browser-local event counters for page views, camera
  authorization, first tracking, screenshots, shares, product selection, and
  purchase clicks.
- Added a compact local analytics panel for selected-product try-ons,
  screenshots, purchase clicks, authorization rate, and try-on-to-purchase rate.

### Fixed

- Fixed cross-platform dependency installation for Linux release runners.

### Verified

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run build`

## [0.1.0] - 2026-08-31

### Added

- Added a mobile-first bracelet try-on page with explicit camera startup.
- Added MediaPipe Hand Landmarker tracking for left and right hands.
- Added Three.js bracelet rendering with 3D wrist pose, depth-only wrist proxy,
  orientation tracking, and damped gravity motion.
- Added automatic wrist-size fitting that follows approach and recede movement
  while holding size during wrist rotation.
- Added product switching, calibration controls, screenshot download, sharing,
  and purchase-link navigation.
- Added local-only camera processing messaging and camera failure states.

### Verified

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `git diff --check`

Future work is tracked in `ROADMAP.md` and `TODO.md`.
