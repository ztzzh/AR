# Roadmap

This roadmap keeps the project focused on the first commercial loop:

```text
open page -> authorize camera -> try on bracelet -> screenshot/share -> buy
```

## Current Release: 0.1.0

- Browser-based bracelet try-on prototype.
- MediaPipe hand tracking with left/right hand selection.
- Three.js 3D bracelet rendering and wrist occlusion proxy.
- Automatic wrist-size fitting and calibration controls.
- Screenshot, share, and purchase-link actions.

## Next: Mobile Validation

- Validate iPhone Safari and Android Chrome with HTTPS camera access.
- Measure tracking latency, frame rate, and size response at different distances.
- Test bright, dim, backlit, left-hand, right-hand, rotating-wrist, and multi-hand scenes.
- Tune the automatic fitting and pose thresholds from recorded test observations.

## Following: Web MVP

- Add a stable product configuration model for anchor, scale, rotation, width,
  opacity, z-index, and hand support.
- Persist product and calibration data through an API.
- Add basic try-on and purchase-click analytics.
- Add privacy policy, terms, asset authorization records, and deletion flows.
- Deploy the try-on page over HTTPS with a production asset CDN.

## Later: Merchant And AI Features

- Merchant product upload and publish workflow.
- Transparent-image validation and assisted background removal.
- Asset quality checks, anchor recommendations, and human confirmation.
- Static model try-on images and campaign content generation.
- Optional high-precision MANO hand mesh after asset licensing review.

## Out Of Scope For The Current Prototype

- Payment, order management, and complex marketplace integrations.
- Native mobile applications.
- Real-time Gaussian splatting.
- Full jewelry category coverage and precise ring sizing.
