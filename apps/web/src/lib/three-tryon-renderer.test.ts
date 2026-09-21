import * as THREE from "three";
import { describe, expect, test } from "vitest";

import {
  BraceletOrientationSmoother,
  calculateBraceletAutoFitScale,
  calculateOrientationConfidence,
} from "./three-tryon-renderer";

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
