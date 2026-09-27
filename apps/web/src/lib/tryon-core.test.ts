import { describe, expect, test } from "vitest";

import {
  applyForearmAxisToWristPose,
  applyPoseHandWristBasis,
  calculateBasisOrthogonalityError,
  calculateMirroredSceneAngle,
  calculateMirroredStageAngle,
  calculatePoseForearmAxis,
  calculatePoseHandWristBasis,
  calculateScreenSpaceWristFit,
  calculateScreenAxisAngleError,
  calculateScreenAngleError,
  calculateWorldDownInThree,
  calculateWristPose,
  mapCameraPointToStage,
  resolvePoseForearmDepth,
  selectPrimaryHand,
  ScreenSpaceWristFitSmoother,
  WristPoseSmoother,
  WristScaleController,
  type HandLandmark,
  type HandLandmarkerResult,
  type PoseLandmarkerResult,
  type ScreenSpaceWristFit,
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

const makePoseResult = (): PoseLandmarkerResult => {
  const landmarks = Array.from({ length: 33 }, () => landmark(0.5, 0.5));
  const worldLandmarks = Array.from({ length: 33 }, () => landmark(0, 0));
  landmarks[13] = landmark(0.46, 0.9, 0, 0.94);
  landmarks[15] = landmark(0.5, 0.7, 0, 0.91);
  landmarks[14] = landmark(0.76, 0.9, 0, 0.97);
  landmarks[16] = landmark(0.8, 0.7, 0, 0.96);
  worldLandmarks[13] = landmark(-0.1, 0.2, 0.1);
  worldLandmarks[15] = landmark(0.1, -0.2, -0.1);
  worldLandmarks[14] = landmark(0.2, 0.2, 0);
  worldLandmarks[16] = landmark(0.2, -0.2, 0);
  return { landmarks: [landmarks], worldLandmarks: [worldLandmarks] };
};

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

describe("Pose forearm armAxis", () => {
  test("uses the Pose wrist nearest the tracked hand before handedness labels", () => {
    const result = calculatePoseForearmAxis(
      makePoseResult(),
      landmark(0.5, 0.7),
      "Right",
      1,
    );

    expect(result?.handedness).toBe("Left");
    expect(result?.confidence).toBeCloseTo(0.91, 6);
    expect(result?.rawAxis).toEqual({ x: 0.2, y: -0.4, z: -0.2 });
    expect(result?.axis.x).toBeCloseTo(1 / Math.sqrt(6), 6);
    expect(result?.axis.y).toBeCloseTo(-2 / Math.sqrt(6), 6);
    expect(result?.axis.z).toBeCloseTo(-1 / Math.sqrt(6), 6);
  });

  test("uses Pose only for armAxis and projects Hand orientation into twist", () => {
    const pose = makePose({
      lateralAxis: { x: 1, y: 0, z: 0 },
      palmNormal: { x: 0, y: 0, z: -1 },
    });
    const result = applyForearmAxisToWristPose(pose, {
      x: 0,
      y: Math.SQRT1_2,
      z: Math.SQRT1_2,
    });

    expect(result).not.toBeNull();
    expect(result?.x).toBe(pose.x);
    expect(result?.wristWidth).toBe(pose.wristWidth);
    expect(result?.armAxis.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(result?.armAxis.z).toBeCloseTo(Math.SQRT1_2, 6);
    const armLateralDot =
      (result?.armAxis.x ?? 0) * (result?.lateralAxis.x ?? 0) +
      (result?.armAxis.y ?? 0) * (result?.lateralAxis.y ?? 0) +
      (result?.armAxis.z ?? 0) * (result?.lateralAxis.z ?? 0);
    expect(armLateralDot).toBeCloseTo(0, 6);
    expect(result?.lateralAxis.x).toBeGreaterThan(0.99);
    expect(result?.twistConfidence).toBe(pose.confidence);
  });
});

describe("Pose Forearm Depth toggle", () => {
  const rawAxis = { x: 0.2, y: -0.4, z: -0.2 };

  test("3D preserves the current raw Pose forearm vector", () => {
    const result = resolvePoseForearmDepth(rawAxis, "3d");

    expect(result?.rawAxis).toEqual(rawAxis);
    expect(result?.axis.x).toBeCloseTo(1 / Math.sqrt(6), 6);
    expect(result?.axis.y).toBeCloseTo(-2 / Math.sqrt(6), 6);
    expect(result?.axis.z).toBeCloseTo(-1 / Math.sqrt(6), 6);
    expect(result?.depthTiltAngle).toBeCloseTo(-24.094843, 6);
  });

  test("Flat keeps Pose x/y and zeros raw z before normalization", () => {
    const result = resolvePoseForearmDepth(rawAxis, "flat");

    expect(result?.rawAxis).toEqual({ x: 0.2, y: -0.4, z: 0 });
    expect(result?.axis.x).toBeCloseTo(1 / Math.sqrt(5), 6);
    expect(result?.axis.y).toBeCloseTo(-2 / Math.sqrt(5), 6);
    expect(result?.axis.z).toBe(0);
    expect(result?.depthTiltAngle).toBe(0);
  });
});

describe("D mode Pose + Hand orthogonal wrist basis", () => {
  const makeWorldHand = () => {
    const landmarks = Array.from({ length: 21 }, () => landmark(0, 0, 0));
    landmarks[5] = landmark(-0.2, 0.1, 0.3);
    landmarks[17] = landmark(0.5, 0.6, -0.1);
    return landmarks;
  };

  test("Gram-Schmidt makes all three basis axes mutually orthogonal", () => {
    const basis = calculatePoseHandWristBasis(
      { x: 0.3, y: 0.8, z: 0.5 },
      makeWorldHand(),
    );

    expect(basis).not.toBeNull();
    expect(calculateBasisOrthogonalityError(basis!)).toBeLessThan(1e-12);
    expect(
      Math.hypot(
        basis?.armAxis.x ?? 0,
        basis?.armAxis.y ?? 0,
        basis?.armAxis.z ?? 0,
      ),
    ).toBeCloseTo(1, 10);
    expect(
      Math.hypot(
        basis?.lateralAxis.x ?? 0,
        basis?.lateralAxis.y ?? 0,
        basis?.lateralAxis.z ?? 0,
      ),
    ).toBeCloseTo(1, 10);
    expect(
      Math.hypot(
        basis?.normal.x ?? 0,
        basis?.normal.y ?? 0,
        basis?.normal.z ?? 0,
      ),
    ).toBeCloseTo(1, 10);
  });

  test("replaces only orientation while preserving anchor, depth, and fit", () => {
    const pose = makePose({ x: 0.42, y: 0.63, depth: -0.18 });
    const result = applyPoseHandWristBasis(
      pose,
      { x: 0.3, y: 0.8, z: 0.5 },
      makeWorldHand(),
    );

    expect(result).not.toBeNull();
    expect(result?.x).toBe(pose.x);
    expect(result?.y).toBe(pose.y);
    expect(result?.depth).toBe(pose.depth);
    expect(result?.wristWidth).toBe(pose.wristWidth);
    expect(
      calculateBasisOrthogonalityError({
        armAxis: result!.armAxis,
        lateralAxis: result!.lateralAxis,
        normal: result!.palmNormal,
      }),
    ).toBeLessThan(1e-12);
  });

  test("rejects a degenerate Hand lateral parallel to the Pose arm", () => {
    const landmarks = makeWorldHand();
    landmarks[5] = landmark(0, 0, 0);
    landmarks[17] = landmark(1, 0, 0);

    expect(
      calculatePoseHandWristBasis(
        { x: 1, y: 0, z: 0 },
        landmarks,
      ),
    ).toBeNull();
  });
});

describe("camera-to-stage orientation diagnostics", () => {
  test("preserves the visible forearm angle through cover crop and mirror", () => {
    const sourceAspect = 16 / 9;
    const stageAspect = 3 / 4;
    const elbow = mapCameraPointToStage(
      { x: 0.4, y: 0.4 },
      sourceAspect,
      stageAspect,
    );
    const wrist = mapCameraPointToStage(
      { x: 0.6, y: 0.6 },
      sourceAspect,
      stageAspect,
    );
    const forearmAngle = calculateMirroredStageAngle(
      elbow,
      wrist,
      stageAspect,
    );
    const braceletNormalAngle = calculateMirroredSceneAngle({
      x: 0.2 * sourceAspect,
      y: -0.2,
      z: 0.5,
    });

    expect(forearmAngle).toBeCloseTo(150.64, 2);
    expect(braceletNormalAngle).toBeCloseTo(forearmAngle ?? 0, 8);
    expect(
      calculateScreenAngleError(forearmAngle, braceletNormalAngle),
    ).toBeCloseTo(0, 8);
  });

  test("treats opposite screen directions as the same diagnostic axis", () => {
    expect(calculateScreenAxisAngleError(90, -90)).toBe(0);
    expect(calculateScreenAxisAngleError(10, 175)).toBe(15);
    expect(calculateScreenAxisAngleError(null, 10)).toBeNull();
  });

  test.each([
    { acceleration: { x: 0, y: 9.8, z: 0 }, angle: 0 },
    { acceleration: { x: -9.8, y: 0, z: 0 }, angle: 90 },
    { acceleration: { x: 0, y: -9.8, z: 0 }, angle: 180 },
    { acceleration: { x: 9.8, y: 0, z: 0 }, angle: 270 },
  ])(
    "maps physical down to screen down at $angle degrees",
    ({ acceleration, angle }) => {
      const down = calculateWorldDownInThree(acceleration, angle);

      expect(down?.x).toBeCloseTo(0, 8);
      expect(down?.y).toBeCloseTo(-1, 8);
      expect(down?.z).toBeCloseTo(0, 8);
      expect(calculateMirroredSceneAngle(down!)).toBeCloseTo(90, 8);
    },
  );

  test("applies the front-camera mirror to a diagonal gravity projection", () => {
    const down = calculateWorldDownInThree({ x: 1, y: 1, z: 0 }, 0);

    expect(calculateMirroredSceneAngle(down!)).toBeCloseTo(45, 8);
  });

  test("keeps physical down on Three.js -Z when the screen faces upward", () => {
    const down = calculateWorldDownInThree({ x: 0, y: 0, z: 9.8 }, 0);

    expect(down?.x).toBeCloseTo(0, 8);
    expect(down?.y).toBeCloseTo(0, 8);
    expect(down?.z).toBeCloseTo(-1, 8);
    expect(calculateMirroredSceneAngle(down!)).toBeNull();
  });
});

describe("C mode screen-space wrist fitting", () => {
  test("constructs L/R in stage-height units around the stable wrist anchor", () => {
    const fit = calculateScreenSpaceWristFit(
      makePose({ x: 0.5, y: 0.64, wristWidth: 0.18 }),
      makeHand(0.5),
      4 / 3,
      3 / 4,
      1.06,
    );

    expect(fit).not.toBeNull();
    expect(fit?.center).toEqual({ x: 0.5, y: 0.64 });
    expect(fit?.wristScreenWidth).toBeCloseTo(0.18, 8);
    expect(fit?.left.x).toBeCloseTo(0.38, 8);
    expect(fit?.right.x).toBeCloseTo(0.62, 8);
    expect(fit?.left.y).toBeCloseTo(0.64, 8);
    expect(fit?.right.y).toBeCloseTo(0.64, 8);
    expect(fit?.diameter).toBeCloseTo(0.18 * 1.06, 8);
    expect(fit?.angle).toBeCloseTo(0, 8);
  });

  test("converts source wrist width through object-fit cover", () => {
    const fit = calculateScreenSpaceWristFit(
      makePose({ wristWidth: 0.18 }),
      makeHand(0.5),
      3 / 4,
      3 / 2,
      1.05,
    );

    expect(fit?.wristScreenWidth).toBeCloseTo(0.36, 8);
    const dx =
      ((fit?.right.x ?? 0) - (fit?.left.x ?? 0)) * (fit?.stageAspect ?? 1);
    const dy = (fit?.right.y ?? 0) - (fit?.left.y ?? 0);
    expect(Math.hypot(dx, dy)).toBeCloseTo(0.36, 8);
  });

  test("smooths across the ±pi boundary without rotating through zero", () => {
    const smoother = new ScreenSpaceWristFitSmoother();
    const makeFit = (angle: number): ScreenSpaceWristFit => ({
      center: { x: 0.5, y: 0.5 },
      left: { x: 0.6, y: 0.5 },
      right: { x: 0.4, y: 0.5 },
      wristScreenWidth: 0.2,
      diameter: 0.212,
      angle,
      stageAspect: 1,
      confidence: 1,
    });
    smoother.update(makeFit((179 * Math.PI) / 180), 1000);

    const result = smoother.update(makeFit((-179 * Math.PI) / 180), 1016);

    expect(Math.abs(result.angle)).toBeGreaterThan((175 * Math.PI) / 180);
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
