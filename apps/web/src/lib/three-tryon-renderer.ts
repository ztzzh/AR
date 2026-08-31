import * as THREE from "three";

import type { Vector3, WristPose } from "@/lib/tryon-core";

type ProductAppearance = {
  tint: string;
  accent: string;
  widthRatio?: number;
};

type PhysicsState = {
  roll: number;
  slide: number;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const toThreeVector = (vector: Vector3) =>
  new THREE.Vector3(vector.x, -vector.y, -vector.z).normalize();

const braceletOuterDiameter = 1.128;

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
  private widthRatio = 1.04;
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
      clearcoat: 0.58,
      clearcoatRoughness: 0.14,
      envMapIntensity: 1.2,
    });
    this.gemMaterial = new THREE.MeshPhysicalMaterial({
      color: appearance.accent,
      metalness: 0.18,
      roughness: 0.12,
      transmission: 0.08,
      clearcoat: 0.95,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.4,
    });

    const braceletMesh = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.064, 24, 96),
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
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
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
    this.widthRatio = clamp(appearance.widthRatio ?? 1.04, 0.82, 1.18);
  }

  render(pose: WristPose | null, physics: PhysicsState, opacity: number) {
    if (!pose || pose.confidence < 0.35) {
      this.proxyGroup.visible = false;
      this.braceletGroup.visible = false;
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const aspect = this.width / this.height;
    const right = toThreeVector(pose.lateralAxis);
    const up = toThreeVector(pose.palmNormal);
    const arm = toThreeVector(pose.armAxis);
    const basis = new THREE.Matrix4().makeBasis(right, up, arm);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis);
    // Palm length follows the forearm axis and stays usable while the hand
    // rolls edge-on; transverse palm width would shrink the whole bracelet.
    const screenScale =
      pose.palmLength / Math.max(pose.worldPalmLength, 0.001);
    const metersToScene =
      Math.max(screenScale, 0.02) * 2;
    const targetDiameter =
      Math.max(pose.wristWidth, 0.02) * 2 * this.widthRatio;
    const braceletScale = targetDiameter / braceletOuterDiameter;
    const position = new THREE.Vector3(
      (pose.x - 0.5) * 2 * aspect,
      (0.5 - pose.y) * 2,
      clamp(-pose.depth * 1.4, -0.34, 0.34),
    );
    position.addScaledVector(arm, physics.slide * metersToScene);

    this.proxyGroup.visible = true;
    this.proxyGroup.position.copy(position);
    this.proxyGroup.quaternion.copy(quaternion);
    this.proxyGroup.scale.set(
      braceletScale * 0.78,
      braceletScale * 0.78,
      braceletScale * 1.1,
    );

    this.braceletGroup.visible = true;
    this.braceletGroup.position.copy(position);
    this.braceletGroup.quaternion.copy(quaternion);
    this.braceletGroup.scale.setScalar(braceletScale);
    this.visualGroup.rotation.set(
      0,
      0,
      physics.roll,
    );
    this.visualGroup.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material) {
        const material = object.material as THREE.Material & {
          opacity?: number;
          transparent?: boolean;
        };
        if ("opacity" in material) material.opacity = opacity;
        if ("transparent" in material) material.transparent = opacity < 1;
      }
    });

    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    this.proxyGroup.visible = false;
    this.braceletGroup.visible = false;
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
