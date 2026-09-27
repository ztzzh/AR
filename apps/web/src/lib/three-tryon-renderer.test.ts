import * as THREE from "three";
import { describe, expect, test } from "vitest";

import {
  AdaptiveBasisRotationSmoother,
  BraceletOrientationSmoother,
  calculateBraceletAutoFitScale,
  calculateOrientationConfidence,
  calculateScreenSpaceBraceletScale,
  calculateTwistConfidence,
  createBraceletOrientationQuaternion,
  createWristBasisQuaternion,
  localRingNormal,
} from "./three-tryon-renderer";

describe("AdaptiveBasisRotationSmoother", () => {
  test("OFF copies the target quaternion directly with alpha 1", () => {
    const smoother = new AdaptiveBasisRotationSmoother();
    const identity = new THREE.Quaternion();
    const quarterTurn = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    smoother.update(identity, false);

    const result = smoother.update(quarterTurn, false);

    expect(result.debug.enabled).toBe(false);
    expect(result.debug.errorDegrees).toBeCloseTo(90, 8);
    expect(result.debug.alpha).toBe(1);
    expect(result.quaternion.angleTo(quarterTurn)).toBeCloseTo(0, 10);
  });

  test("ON keeps small changes stable and gives large changes a higher alpha", () => {
    const smallSmoother = new AdaptiveBasisRotationSmoother();
    const largeSmoother = new AdaptiveBasisRotationSmoother();
    const identity = new THREE.Quaternion();
    const smallTarget = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      0.05,
    );
    const largeTarget = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI,
    );
    smallSmoother.update(identity, true);
    largeSmoother.update(identity, true);

    const small = smallSmoother.update(smallTarget, true);
    const large = largeSmoother.update(largeTarget, true);

    expect(small.debug.alpha).toBeGreaterThanOrEqual(0.35);
    expect(large.debug.alpha).toBeCloseTo(0.92, 8);
    expect(large.debug.alpha).toBeGreaterThan(small.debug.alpha);
    expect(small.quaternion.angleTo(smallTarget)).toBeLessThan(0.05);
  });
});

describe("createBraceletOrientationQuaternion", () => {
  test("maps the Torus local +Z normal exactly onto the forearm axis", () => {
    const forearm = new THREE.Vector3(0.31, -0.72, 0.62).normalize();
    const palmTwistReference = new THREE.Vector3(0.88, 0.4, 0.24);
    const quaternion = createBraceletOrientationQuaternion(
      forearm,
      palmTwistReference,
    );
    const renderedNormal = localRingNormal
      .clone()
      .applyQuaternion(quaternion);

    expect(renderedNormal.dot(forearm)).toBeCloseTo(1, 10);
  });

  test("different Hand twists cannot tilt the ring normal", () => {
    const forearm = new THREE.Vector3(-0.42, 0.33, 0.85).normalize();
    const first = createBraceletOrientationQuaternion(
      forearm,
      new THREE.Vector3(1, 0, 0),
    );
    const second = createBraceletOrientationQuaternion(
      forearm,
      new THREE.Vector3(0, 1, 0),
    );

    expect(
      localRingNormal.clone().applyQuaternion(first).dot(forearm),
    ).toBeCloseTo(1, 10);
    expect(
      localRingNormal.clone().applyQuaternion(second).dot(forearm),
    ).toBeCloseTo(1, 10);
  });

  test("turns the bracelet around a fixed forearm when Hand twist changes", () => {
    const forearm = new THREE.Vector3(0, 0, 1);
    const untwisted = createBraceletOrientationQuaternion(
      forearm,
      new THREE.Vector3(1, 0, 0),
    );
    const quarterTurn = createBraceletOrientationQuaternion(
      forearm,
      new THREE.Vector3(0, 1, 0),
    );
    const renderedRight = new THREE.Vector3(1, 0, 0).applyQuaternion(
      quarterTurn,
    );

    expect(quarterTurn.angleTo(untwisted)).toBeCloseTo(Math.PI / 2, 8);
    expect(renderedRight.x).toBeCloseTo(0, 8);
    expect(renderedRight.y).toBeCloseTo(1, 8);
    expect(
      localRingNormal.clone().applyQuaternion(quarterTurn).dot(forearm),
    ).toBeCloseTo(1, 10);
  });
});

describe("createWristBasisQuaternion", () => {
  test("maps local X/Y/Z directly to lateral/normal/arm", () => {
    const quaternion = createWristBasisQuaternion({
      armAxis: { x: 0, y: 1, z: 0 },
      lateralAxis: { x: 1, y: 0, z: 0 },
      palmNormal: { x: 0, y: 0, z: -1 },
    });

    expect(
      new THREE.Vector3(1, 0, 0)
        .applyQuaternion(quaternion)
        .distanceTo(new THREE.Vector3(1, 0, 0)),
    ).toBeLessThan(1e-10);
    expect(
      new THREE.Vector3(0, 1, 0)
        .applyQuaternion(quaternion)
        .distanceTo(new THREE.Vector3(0, 0, 1)),
    ).toBeLessThan(1e-10);
    expect(
      new THREE.Vector3(0, 0, 1)
        .applyQuaternion(quaternion)
        .distanceTo(new THREE.Vector3(0, -1, 0)),
    ).toBeLessThan(1e-10);
  });
});

describe("calculateBraceletAutoFitScale", () => {
  test("fits the torus inner diameter to the full normalized wrist width", () => {
    const wristWidth = 0.18;
    const fitRatio = 1.06;
    const braceletInnerDiameter = 2 * (0.5 - 0.064);
    const scale = calculateBraceletAutoFitScale(wristWidth, fitRatio);

    expect(scale * braceletInnerDiameter).toBeCloseTo(
      wristWidth * 2 * fitRatio,
      8,
    );
  });
});

describe("calculateOrientationConfidence", () => {
  test("drops as the projected palm width collapses in side view", () => {
    const front = calculateOrientationConfidence({
      palmWidth: 0.16,
      palmLength: 0.28,
    });
    const side = calculateOrientationConfidence({
      palmWidth: 0.04,
      palmLength: 0.28,
    });

    expect(front).toBeGreaterThan(0.98);
    expect(side).toBe(0);
  });

  test("uses Hand confidence for Pose-mode twist in a side view", () => {
    const pose = {
      palmWidth: 0.04,
      palmLength: 0.28,
      twistConfidence: 0.87,
    };

    expect(calculateOrientationConfidence(pose)).toBe(0);
    expect(calculateTwistConfidence(pose)).toBeCloseTo(0.87, 8);
  });

  test("keeps the projected-width gate for Hand-only mode", () => {
    expect(
      calculateTwistConfidence({ palmWidth: 0.04, palmLength: 0.28 }),
    ).toBe(0);
  });

  test("maps C-mode projected diameter to the torus outer extrema", () => {
    const diameter = 0.18 * 1.06;
    const braceletOuterDiameter = 2 * (0.5 + 0.064);
    const scale = calculateScreenSpaceBraceletScale(diameter);

    expect(scale * braceletOuterDiameter).toBeCloseTo(diameter * 2, 8);
  });
});

describe("BraceletOrientationSmoother", () => {
  const localArm = new THREE.Vector3(0, 0, 1);

  test("uses quaternion slerp instead of snapping high-confidence twist", () => {
    const smoother = new BraceletOrientationSmoother();
    const initial = new THREE.Quaternion();
    const quarterTurn = new THREE.Quaternion().setFromAxisAngle(
      localArm,
      Math.PI / 2,
    );
    smoother.update(initial, localArm, 1, 0, true);

    const result = smoother.update(quarterTurn, localArm, 1, 16, true);

    expect(result.angleTo(initial)).toBeGreaterThan(0);
    expect(result.angleTo(initial)).toBeLessThan(Math.PI / 2);
  });

  test("keeps the new arm axis while holding low-confidence twist", () => {
    const smoother = new BraceletOrientationSmoother();
    smoother.update(new THREE.Quaternion(), localArm, 1, 0, true);
    const nextArm = new THREE.Vector3(0, 1, 0);
    const target = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, 0, 0),
        nextArm,
      ),
    );

    const result = smoother.update(target, nextArm, 0, 16, true);
    const renderedArm = localArm.clone().applyQuaternion(result);
    const renderedRight = new THREE.Vector3(1, 0, 0).applyQuaternion(result);

    expect(renderedArm.dot(nextArm)).toBeCloseTo(1, 6);
    expect(renderedRight.dot(new THREE.Vector3(1, 0, 0))).toBeGreaterThan(0.99);
  });

  test("can be disabled for raw-orientation A/B testing", () => {
    const smoother = new BraceletOrientationSmoother();
    const initial = new THREE.Quaternion();
    const target = new THREE.Quaternion().setFromAxisAngle(
      localArm,
      Math.PI / 2,
    );
    smoother.update(initial, localArm, 1, 0, true);

    const result = smoother.update(target, localArm, 0, 16, false);

    expect(result.angleTo(target)).toBeCloseTo(0, 8);
  });

});
