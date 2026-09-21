import * as THREE from "three";

import type { Vector3, WristPose } from "@/lib/tryon-core";

type ProductAppearance = {
  tint: string;
  accent: string;
  braceletFitRatio?: number;
  braceletAspectRatio?: number;
  wristProxyWidthRatio?: number;
  rotationSmoothingEnabled?: boolean;
  autoFitEnabled?: boolean;
  minimumScale?: number;
  maximumScale?: number;
  manualScale?: number;
};

type PhysicsState = {
  roll: number;
  slide: number;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const toThreeVector = (vector: Vector3) =>
  new THREE.Vector3(vector.x, -vector.y, -vector.z).normalize();

const braceletMajorRadius = 0.5;
const braceletTubeRadius = 0.064;
const braceletInnerDiameter =
  2 * (braceletMajorRadius - braceletTubeRadius);
const normalizedPoseUnitsToSceneUnits = 2;
const orientationConfidenceMinimumRatio = 0.22;
const orientationConfidenceMaximumRatio = 0.58;
const orientationSmoothingResponse = 12;
const sideViewTwistUpdateFloor = 0.02;

const localRightAxis = new THREE.Vector3(1, 0, 0);
const localUpAxis = new THREE.Vector3(0, 1, 0);

export const calculateOrientationConfidence = (
  pose: Pick<WristPose, "palmWidth" | "palmLength">,
) => {
  const projectedPalmRatio =
    pose.palmWidth / Math.max(pose.palmLength, 0.001);
  const normalized = clamp(
    (projectedPalmRatio - orientationConfidenceMinimumRatio) /
      (orientationConfidenceMaximumRatio - orientationConfidenceMinimumRatio),
    0,
    1,
  );
  return normalized * normalized * (3 - 2 * normalized);
};

export class BraceletOrientationSmoother {
  private readonly quaternion = new THREE.Quaternion();
  private initialized = false;
  private lastTimestamp = 0;

  update(
    targetQuaternion: THREE.Quaternion,
    targetArmAxis: THREE.Vector3,
    orientationConfidence: number,
    timestamp: number,
    enabled: boolean,
  ) {
    const arm = targetArmAxis.clone().normalize();
    if (!enabled || !this.initialized) {
      this.quaternion.copy(targetQuaternion);
      this.initialized = true;
      this.lastTimestamp = timestamp;
      return this.quaternion;
    }

    const previousRight = localRightAxis.clone().applyQuaternion(this.quaternion);
    const heldRight = previousRight.addScaledVector(
      arm,
      -previousRight.dot(arm),
    );
    if (heldRight.lengthSq() < 1e-6) {
      const previousUp = localUpAxis.clone().applyQuaternion(this.quaternion);
      previousUp.addScaledVector(arm, -previousUp.dot(arm)).normalize();
      heldRight.crossVectors(previousUp, arm);
    }
    heldRight.normalize();
    const heldUp = new THREE.Vector3().crossVectors(arm, heldRight).normalize();

    const targetRight = localRightAxis
      .clone()
      .applyQuaternion(targetQuaternion);
    const targetUp = localUpAxis.clone().applyQuaternion(targetQuaternion);
    if (targetRight.dot(heldRight) + targetUp.dot(heldUp) < 0) {
      targetRight.negate();
      targetUp.negate();
    }

    const heldQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(heldRight, heldUp, arm),
    );
    const continuousTargetQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(targetRight, targetUp, arm),
    );
    const elapsed = this.lastTimestamp
      ? clamp((timestamp - this.lastTimestamp) / 1000, 1 / 240, 0.1)
      : 1 / 60;
    const smoothingAlpha = 1 - Math.exp(-orientationSmoothingResponse * elapsed);
    const confidence = clamp(orientationConfidence, 0, 1);
    const twistUpdateWeight =
      sideViewTwistUpdateFloor +
      (1 - sideViewTwistUpdateFloor) * confidence * confidence;

    this.quaternion.copy(
      heldQuaternion.slerp(
        continuousTargetQuaternion,
        smoothingAlpha * twistUpdateWeight,
      ),
    );
    this.lastTimestamp = timestamp;
    return this.quaternion;
  }

  reset() {
    this.quaternion.identity();
    this.initialized = false;
    this.lastTimestamp = 0;
  }
}

export const calculateBraceletAutoFitScale = (
  wristWidth: number,
  fitRatio: number,
) => {
  // WristPose distances are full spans in normalized frame-height units.
  // The orthographic camera is two scene units tall, so this is a unit
  // conversion rather than a radius-to-diameter conversion.
  const wristOuterWidthInScene =
    Math.max(wristWidth, 0.02) * normalizedPoseUnitsToSceneUnits;
  const desiredInnerDiameter = wristOuterWidthInScene * fitRatio;
  return desiredInnerDiameter / braceletInnerDiameter;
};

export class ThreeTryOnRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(
    -1,
    1,
    1,
    -1,
    0.01,
    10,
  );
  private readonly renderer: THREE.WebGLRenderer;
  private readonly proxyGroup = new THREE.Group();
  private readonly braceletGroup = new THREE.Group();
  private readonly visualGroup = new THREE.Group();
  private readonly metalMaterial: THREE.MeshPhysicalMaterial;
  private readonly gemMaterial: THREE.MeshPhysicalMaterial;
  private readonly gemMeshes: THREE.Mesh[] = [];
  private readonly orientationSmoother = new BraceletOrientationSmoother();
  private braceletFitRatio = 1.06;
  private braceletAspectRatio = 0.76;
  private wristProxyWidthRatio = 0.88;
  private rotationSmoothingEnabled = true;
  private autoFitEnabled = true;
  private minimumScale = 0.08;
  private maximumScale = 0.75;
  private manualScale = 0.22;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement, appearance: ProductAppearance) {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.domElement.className = "three-overlay";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(this.renderer.domElement);

    this.camera.position.z = 4;
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight(0xfff7e8, 0x25302b, 2.2));
    const keyLight = new THREE.DirectionalLight(0xfff1d2, 3.6);
    keyLight.position.set(-2.5, 3.5, 4);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xbdd7e6, 1.6);
    rimLight.position.set(3, -1.5, 2);
    this.scene.add(rimLight);

    this.metalMaterial = new THREE.MeshPhysicalMaterial({
      color: appearance.tint,
      metalness: 0.92,
      roughness: 0.18,
      transparent: true,
      clearcoat: 0.58,
      clearcoatRoughness: 0.14,
      envMapIntensity: 1.2,
    });
    this.gemMaterial = new THREE.MeshPhysicalMaterial({
      color: appearance.accent,
      metalness: 0.18,
      roughness: 0.12,
      transparent: true,
      transmission: 0.08,
      clearcoat: 0.95,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.4,
    });

    const braceletMesh = new THREE.Mesh(
      new THREE.TorusGeometry(
        braceletMajorRadius,
        braceletTubeRadius,
        24,
        96,
      ),
      this.metalMaterial,
    );
    braceletMesh.castShadow = false;
    braceletMesh.receiveShadow = false;
    this.visualGroup.add(braceletMesh);

    const clasp = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.24, 0.14),
      this.metalMaterial,
    );
    clasp.position.set(0.48, -0.05, 0.02);
    clasp.rotation.z = -0.28;
    this.visualGroup.add(clasp);

    for (let index = 0; index < 7; index += 1) {
      const stone = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.045, 0),
        this.gemMaterial,
      );
      const angle = -Math.PI * 0.78 + (index / 6) * Math.PI * 0.46;
      stone.position.set(Math.cos(angle) * 0.56, Math.sin(angle) * 0.56, 0.06);
      stone.scale.set(1, 0.72, 0.52);
      this.visualGroup.add(stone);
      this.gemMeshes.push(stone);
    }

    const proxyMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.DoubleSide,
    });
    const proxy = new THREE.Mesh(
      new THREE.CylinderGeometry(0.43, 0.5, 1.55, 32, 1, false),
      proxyMaterial,
    );
    proxy.geometry.rotateX(Math.PI / 2);
    this.proxyGroup.add(proxy);
    this.proxyGroup.renderOrder = 0;

    this.visualGroup.renderOrder = 1;
    this.braceletGroup.add(this.visualGroup);
    this.scene.add(this.proxyGroup);
    this.scene.add(this.braceletGroup);

    this.setAppearance(appearance);
    this.resize(container.clientWidth || 1, container.clientHeight || 1);
  }

  resize(width: number, height: number) {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    if (nextWidth === this.width && nextHeight === this.height) return;

    this.width = nextWidth;
    this.height = nextHeight;
    const aspect = this.width / this.height;
    this.camera.left = -aspect;
    this.camera.right = aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height, false);
  }

  setAppearance(appearance: ProductAppearance) {
    this.metalMaterial.color.set(appearance.tint);
    this.gemMaterial.color.set(appearance.accent);
    this.braceletFitRatio = clamp(
      appearance.braceletFitRatio ?? 1.06,
      1,
      1.15,
    );
    this.braceletAspectRatio = clamp(
      appearance.braceletAspectRatio ?? 0.76,
      0.6,
      1,
    );
    this.wristProxyWidthRatio = clamp(
      appearance.wristProxyWidthRatio ?? 0.88,
      0.75,
      0.95,
    );
    const rotationSmoothingEnabled =
      appearance.rotationSmoothingEnabled ?? true;
    if (rotationSmoothingEnabled !== this.rotationSmoothingEnabled) {
      this.orientationSmoother.reset();
    }
    this.rotationSmoothingEnabled = rotationSmoothingEnabled;
    this.autoFitEnabled = appearance.autoFitEnabled ?? true;
    this.minimumScale = clamp(appearance.minimumScale ?? 0.08, 0.04, 0.45);
    this.maximumScale = Math.max(
      this.minimumScale + 0.01,
      clamp(appearance.maximumScale ?? 0.75, 0.1, 1.2),
    );
    this.manualScale = clamp(
      appearance.manualScale ?? 0.22,
      this.minimumScale,
      this.maximumScale,
    );
  }

  render(
    pose: WristPose | null,
    physics: PhysicsState,
    opacity: number,
    timestamp = performance.now(),
  ) {
    if (!pose || pose.confidence < 0.35) {
      this.proxyGroup.visible = false;
      this.braceletGroup.visible = false;
      this.orientationSmoother.reset();
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const aspect = this.width / this.height;
    const right = toThreeVector(pose.lateralAxis);
    const up = toThreeVector(pose.palmNormal);
    const arm = toThreeVector(pose.armAxis);
    const basis = new THREE.Matrix4().makeBasis(right, up, arm);
    const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(basis);
    const quaternion = this.orientationSmoother.update(
      targetQuaternion,
      arm,
      calculateOrientationConfidence(pose),
      timestamp,
      this.rotationSmoothingEnabled,
    );
    // Palm length follows the forearm axis and stays usable while the hand
    // rolls edge-on; transverse palm width would shrink the whole bracelet.
    const screenScale =
      pose.palmLength / Math.max(pose.worldPalmLength, 0.001);
    const metersToScene =
      Math.max(screenScale, 0.02) * 2;
    const autoFitScale = calculateBraceletAutoFitScale(
      pose.wristWidth,
      this.braceletFitRatio,
    );
    const braceletScale = clamp(
      this.autoFitEnabled ? autoFitScale : this.manualScale,
      this.minimumScale,
      this.maximumScale,
    );
    const position = new THREE.Vector3(
      (pose.x - 0.5) * 2 * aspect,
      (0.5 - pose.y) * 2,
      clamp(-pose.depth * 1.4, -0.34, 0.34),
    );
    position.addScaledVector(arm, physics.slide * metersToScene);

    this.proxyGroup.visible = true;
    this.proxyGroup.position.copy(position);
    this.proxyGroup.quaternion.copy(quaternion);
    // The cylinder's height was rotated onto local Z above. The wrist basis
    // maps local X/Y/Z to lateralAxis/palmNormal/armAxis respectively, so the
    // proxy is wider across the wrist and thinner through the palm.
    const wristProxyWidth = braceletScale * this.wristProxyWidthRatio;
    this.proxyGroup.scale.set(
      wristProxyWidth,
      wristProxyWidth * this.braceletAspectRatio,
      braceletScale * 1.1,
    );

    this.braceletGroup.visible = true;
    this.braceletGroup.position.copy(position);
    this.braceletGroup.quaternion.copy(quaternion);
    this.braceletGroup.scale.set(
      braceletScale,
      braceletScale * this.braceletAspectRatio,
      braceletScale,
    );
    this.visualGroup.rotation.set(
      0,
      0,
      physics.roll,
    );
    this.visualGroup.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material) {
        const material = object.material as THREE.Material & {
          opacity?: number;
        };
        if ("opacity" in material) material.opacity = opacity;
      }
    });

    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    this.proxyGroup.visible = false;
    this.braceletGroup.visible = false;
    this.orientationSmoother.reset();
    this.renderer.render(this.scene, this.camera);
  }

  getCanvas() {
    return this.renderer.domElement;
  }

  dispose() {
    this.renderer.dispose();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => material.dispose());
      } else {
        object.material.dispose();
      }
    });
    this.renderer.domElement.remove();
  }
}
