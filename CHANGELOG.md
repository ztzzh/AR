# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses semantic versioning.

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

## [Unreleased]

Future work is tracked in `ROADMAP.md` and `TODO.md`.
