# TODO

## `apps/web`

- [ ] Run the camera flow on iPhone Safari over HTTPS.
- [ ] Run the camera flow on Android Chrome over HTTPS.
- [ ] Record frame rate and response latency while moving the wrist toward and
      away from the camera.
- [ ] Verify screenshot composition on mobile devices.
- [x] Add a user-visible retry path for model-loading and network failures.
- [ ] Verify Worker-to-main-thread hand tracking fallback on mobile browsers.

## `apps/web/src/lib/tryon-core.ts`

- [x] Add focused unit tests for hand selection, pose continuity, scale fitting,
      and wrist-rotation size locking.
- [ ] Compare automatic wrist-width estimates across hand orientations and
      different camera distances.
- [ ] Tune One Euro filter and auto-fit thresholds using mobile measurements.

## `apps/web/src/lib/three-tryon-renderer.ts`

- [ ] Replace the procedural bracelet with approved product GLB assets.
- [ ] Validate depth proxy dimensions against real wrist proportions.
- [ ] Profile WebGL rendering on low-end Android devices.

## Product And Operations

- [ ] Add persistent product configuration and merchant upload APIs.
- [ ] Move browser-local fitting configuration to the persistent product API
      when the merchant workflow is introduced.
- [x] Add basic try-on and purchase-click event tracking without storing camera
      frames.
- [ ] Move browser-local event counters to the persistent analytics API when
      the merchant workflow is introduced.
- [ ] Add privacy policy, user agreement, deletion flow, and asset license
      metadata before public deployment.
