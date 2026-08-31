# TODO

## `apps/web`

- [ ] Run the camera flow on iPhone Safari over HTTPS.
- [ ] Run the camera flow on Android Chrome over HTTPS.
- [ ] Record frame rate and response latency while moving the wrist toward and
      away from the camera.
- [ ] Verify screenshot composition on mobile devices.
- [ ] Add a user-visible retry path for model-loading and network failures.

## `apps/web/src/lib/tryon-core.ts`

- [ ] Add focused unit tests for hand selection, pose continuity, scale fitting,
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
- [ ] Add basic try-on and purchase-click event tracking without storing camera
      frames.
- [ ] Add privacy policy, user agreement, deletion flow, and asset license
      metadata before public deployment.
