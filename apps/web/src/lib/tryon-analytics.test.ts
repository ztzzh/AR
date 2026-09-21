import { describe, expect, test } from "vitest";

import {
  calculateRate,
  classifyDevice,
  createTryOnAnalytics,
  normalizeTryOnAnalytics,
  recordTryOnEvent,
  summarizeProductAnalytics,
} from "./tryon-analytics";

describe("try-on analytics", () => {
  test("records totals and per-product counters without frame data", () => {
    const started = createTryOnAnalytics("2026-09-20T00:00:00.000Z");
    const next = recordTryOnEvent(started, "tracking_start", {
      productId: "aurora-gold",
      now: "2026-09-20T00:01:00.000Z",
    });

    expect(next.totals.tracking_start).toBe(1);
    expect(summarizeProductAnalytics(next, "aurora-gold").tracking_start).toBe(1);
    expect(JSON.stringify(next)).not.toMatch(/image|frame|video/i);
  });

  test("keeps camera and purchase funnel rates calculable", () => {
    let snapshot = createTryOnAnalytics();
    snapshot = recordTryOnEvent(snapshot, "camera_request");
    snapshot = recordTryOnEvent(snapshot, "camera_request");
    snapshot = recordTryOnEvent(snapshot, "camera_grant");
    snapshot = recordTryOnEvent(snapshot, "purchase_click", {
      productId: "mist-silver",
    });

    expect(calculateRate(snapshot.totals.camera_grant, snapshot.totals.camera_request)).toBe(50);
    expect(summarizeProductAnalytics(snapshot, "mist-silver").purchase_click).toBe(1);
  });

  test("normalizes older or malformed storage values", () => {
    const snapshot = normalizeTryOnAnalytics({
      createdAt: "2026-09-20T00:00:00.000Z",
      totals: { camera_request: 1.2, screenshot: -1 },
      products: {
        "rose-line": {
          counters: { share: 3 },
        },
      },
      errors: { "model-loading": 2.4 },
    });

    expect(snapshot.createdAt).toBe("2026-09-20T00:00:00.000Z");
    expect(snapshot.totals.camera_request).toBe(1);
    expect(snapshot.totals.screenshot).toBe(0);
    expect(summarizeProductAnalytics(snapshot, "rose-line").share).toBe(3);
    expect(snapshot.errors["model-loading"]).toBe(2);
  });

  test("classifies devices from coarse signals without storing raw user agents", () => {
    expect(
      classifyDevice({
        viewportWidth: 390,
        coarsePointer: true,
        userAgent: "Mozilla/5.0 iPhone",
      }),
    ).toBe("mobile");
    expect(
      classifyDevice({
        viewportWidth: 900,
        coarsePointer: true,
        userAgent: "Mozilla/5.0 iPad",
      }),
    ).toBe("tablet");
    expect(
      classifyDevice({
        viewportWidth: 1440,
        coarsePointer: false,
        userAgent: "Mozilla/5.0",
      }),
    ).toBe("desktop");
  });
});
