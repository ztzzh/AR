import { describe, expect, test } from "vitest";

import {
  calculateWristPose,
  selectPrimaryHand,
  WristPoseSmoother,
  WristScaleController,
  type HandLandmark,
  type HandLandmarkerResult,
  type WristPose,
} from "./tryon-core";

const landmark = (
  x: number,
  y: number,
  z = 0,
  visibility = 1,
): HandLandmark => ({ x, y, z, visibility });

const makeHand = (wristX: number, confidence = 1): HandLandmark[] => {
  const points = Array.from({ length: 21 }, () =>
    landmark(wristX, 0.58, 0, confidence),
  );
  points[0] = landmark(wristX, 0.7, 0, confidence);
  points[5] = landmark(wristX - 0.08, 0.46, 0, confidence);
  points[9] = landmark(wristX - 0.02, 0.38, 0, confidence);
  points[13] = landmark(wristX + 0.02, 0.38, 0, confidence);
  points[17] = landmark(wristX + 0.08, 0.46, 0, confidence);
  return points;
};

const makeResult = (
  hands: HandLandmark[][],
  labels: Array<["Left" | "Right", number]>,
): HandLandmarkerResult => ({
  landmarks: hands,
  worldLandmarks: hands,
  handedness: labels.map(([categoryName, score]) => [
    { categoryName, score },
  ]),
});

const makePose = (overrides: Partial<WristPose> = {}): WristPose => ({
  x: 0.5,
  y: 0.7,
  depth: 0,
  palmWidth: 0.16,
  palmLength: 0.28,
  wristWidth: 0.18,
  worldPalmWidth: 0.16,
  worldPalmLength: 0.28,
  armAxis: { x: 0, y: 1, z: 0 },
  lateralAxis: { x: 1, y: 0, z: 0 },
  palmNormal: { x: 0, y: 0, z: -1 },
  confidence: 1,
  handedness: "Right",
  ...overrides,
});

describe("selectPrimaryHand", () => {
  test("keeps the previous handedness when both hands are visible", () => {
    const leftHand = makeHand(0.35, 0.72);
    const rightHand = makeHand(0.52, 0.97);
    const result = makeResult(
      [leftHand, rightHand],
      [
        ["Left", 0.72],
        ["Right", 0.97],
      ],
    );

    expect(
      selectPrimaryHand(result.landmarks, result.handedness, "Left"),
    ).toBe(0);
  });

  test("chooses the strongest candidate when no previous hand exists", () => {
    const dimHand = makeHand(0.5, 0.45);
    const clearHand = makeHand(0.56, 0.92);
    const result = makeResult(
      [dimHand, clearHand],
      [
        ["Left", 0.45],
        ["Right", 0.92],
      ],
    );

    expect(
      selectPrimaryHand(result.landmarks, result.handedness, "Unknown"),
    ).toBe(1);
  });
});

describe("calculateWristPose", () => {
  test("places the default wrist anchor toward the forearm", () => {
    const hand = makeHand(0.5);
    const pose = calculateWristPose(hand, undefined, "Right", {
      anchorMode: "wrist",
      sourceAspect: 1,
    });

    expect(pose).not.toBeNull();
    expect(pose?.handedness).toBe("Right");
    expect(pose?.x).toBeCloseTo(0.5, 4);
    expect(pose?.y).toBeGreaterThan(hand[0].y);
    expect(pose?.wristWidth).toBeGreaterThan(0.16);
  });

  test("rejects a collapsed palm before rendering can use stale geometry", () => {
    const collapsed = makeHand(0.5).map((point) => ({
      ...point,
      x: 0.5,
      y: 0.5,
    }));

    expect(calculateWristPose(collapsed)).toBeNull();
  });
});

describe("WristPoseSmoother", () => {
  test("can bypass x/y filtering while preserving the other smoothing", () => {
    const filteredSmoother = new WristPoseSmoother();
    filteredSmoother.update(makePose({ x: 0.2, y: 0.3 }), 100);
    const filtered = filteredSmoother.update(
      makePose({ x: 0.8, y: 0.9 }),
      133,
    );

    const rawPositionSmoother = new WristPoseSmoother();
    rawPositionSmoother.update(makePose({ x: 0.2, y: 0.3 }), 100, false);
    const rawPosition = rawPositionSmoother.update(
      makePose({ x: 0.8, y: 0.9 }),
      133,
      false,
    );

    expect(filtered?.x).toBeLessThan(0.8);
    expect(filtered?.y).toBeLessThan(0.9);
    expect(rawPosition?.x).toBe(0.8);
    expect(rawPosition?.y).toBe(0.9);
    expect(rawPosition?.depth).toBe(filtered?.depth);
  });

  test("keeps orientation continuous when a noisy frame flips lateral axes", () => {
    const smoother = new WristPoseSmoother();
    const first = smoother.update(makePose(), 0);
    const second = smoother.update(
      makePose({
        lateralAxis: { x: -1, y: 0, z: 0 },
        palmNormal: { x: 0, y: 0, z: 1 },
      }),
      33,
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.lateralAxis.x).toBeGreaterThan(0);
    expect(second?.palmNormal.z).toBeLessThan(0);
  });
});

describe("WristScaleController", () => {
  test("locks the estimated bracelet size while the wrist rotates in place", () => {
    const controller = new WristScaleController();
    let result = controller.update(makePose({ wristWidth: 0.18 }), 0);

    for (let frame = 1; frame <= 10; frame += 1) {
      result = controller.update(makePose({ wristWidth: 0.18 }), frame * 33);
    }

    const lockedWidth = result.wristWidth;
    result = controller.update(
      makePose({
        wristWidth: 0.08,
        lateralAxis: { x: 0.96, y: 0, z: 0.28 },
        palmNormal: { x: 0, y: 0.28, z: -0.96 },
      }),
      380,
    );

    expect(result.status).toBe("locked");
    expect(result.wristWidth).toBeCloseTo(lockedWidth ?? 0, 4);
  });

  test("adapts quickly when palm length shows camera distance changed", () => {
    const controller = new WristScaleController();
    controller.update(makePose({ palmLength: 0.28, wristWidth: 0.14 }), 0);

    const result = controller.update(
      makePose({ palmLength: 0.34, wristWidth: 0.2 }),
      33,
    );

    expect(result.status).toBe("adapting");
    expect(result.wristWidth).toBeGreaterThan(0.14);
  });
});
