export type HandLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type HandednessLabel = "Left" | "Right" | "Unknown";

export type WristPose = {
  x: number;
  y: number;
  depth: number;
  palmWidth: number;
  palmLength: number;
  wristWidth: number;
  worldPalmWidth: number;
  worldPalmLength: number;
  armAxis: Vector3;
  lateralAxis: Vector3;
  palmNormal: Vector3;
  confidence: number;
  handedness: HandednessLabel;
};

export type WristPoseOptions = {
  anchorOffset?: number;
  sourceAspect?: number;
};

export type AutoFitStatus = "settling" | "locked" | "adapting";

export type AutoFitResult = {
  wristWidth: number | null;
  status: AutoFitStatus;
};

const DEFAULT_ANCHOR_OFFSET = 0.17;

export type WristTransform = {
  x: number;
  y: number;
  width: number;
  heightRatio: number;
  rotation: number;
  patternPhase: number;
  patternPhaseConfidence: number;
  confidence: number;
  palmSide: "top" | "bottom";
  palmFacing: number;
};

export class WristTransformSmoother {
  private lastTimestamp = 0;
  private settledFrames = 0;
  private transform: WristTransform | null = null;
  private xFilter = new OneEuroFilter(1.9, 2.2);
  private yFilter = new OneEuroFilter(1.9, 2.2);
  private widthFilter = new OneEuroFilter(1.6, 0.45);
  private heightRatioFilter = new OneEuroFilter(1.8, 0.55);
  private rotationFilter = new OneEuroFilter(1.5, 0.38);
  private patternPhaseFilter = new OneEuroFilter(1.45, 0.46);

  update(next: WristTransform, timestamp: number): WristTransform | null {
    if (!this.transform) {
      this.transform = next;
      this.xFilter.seed(next.x, timestamp);
      this.yFilter.seed(next.y, timestamp);
      this.widthFilter.seed(next.width, timestamp);
      this.heightRatioFilter.seed(next.heightRatio, timestamp);
      this.rotationFilter.seed(next.rotation, timestamp);
      this.patternPhaseFilter.seed(next.patternPhase, timestamp);
      this.lastTimestamp = timestamp;
      this.settledFrames = 1;
      return null;
    }

    const angleDelta = Math.atan2(
      Math.sin(next.rotation - this.transform.rotation),
      Math.cos(next.rotation - this.transform.rotation),
    );
    const targetRotation = this.transform.rotation + angleDelta;
    const patternPhaseDelta = Math.atan2(
      Math.sin(next.patternPhase - this.transform.patternPhase),
      Math.cos(next.patternPhase - this.transform.patternPhase),
    );
    const targetPatternPhase =
      next.patternPhaseConfidence >= 0.35
        ? this.transform.patternPhase + patternPhaseDelta
        : this.transform.patternPhase;
    const palmSide =
      Math.abs(next.palmFacing) >= 0.16
        ? next.palmSide
        : this.transform.palmSide;

    this.transform = {
      x: this.xFilter.filter(next.x, timestamp),
      y: this.yFilter.filter(next.y, timestamp),
      width: this.widthFilter.filter(next.width, timestamp),
      heightRatio: this.heightRatioFilter.filter(
        next.heightRatio,
        timestamp,
      ),
      rotation: this.rotationFilter.filter(targetRotation, timestamp),
      patternPhase: this.patternPhaseFilter.filter(
        targetPatternPhase,
        timestamp,
      ),
      patternPhaseConfidence: next.patternPhaseConfidence,
      confidence: next.confidence,
      palmSide,
      palmFacing: next.palmFacing,
    };
    this.lastTimestamp = timestamp;
    this.settledFrames += 1;

    return this.settledFrames >= 3 ? this.transform : null;
  }

  reset() {
    this.lastTimestamp = 0;
    this.settledFrames = 0;
    this.transform = null;
    this.xFilter.reset();
    this.yFilter.reset();
    this.widthFilter.reset();
    this.heightRatioFilter.reset();
    this.rotationFilter.reset();
    this.patternPhaseFilter.reset();
  }

  hold(timestamp: number, maximumAge = 320): WristTransform | null {
    if (!this.transform || !this.lastTimestamp) return null;
    if (timestamp - this.lastTimestamp > maximumAge) {
      this.reset();
      return null;
    }

    return this.transform;
  }
}

class OneEuroFilter {
  private previousValue: number | null = null;
  private previousDerivative = 0;
  private previousTimestamp = 0;

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly derivativeCutoff = 1,
  ) {}

  seed(value: number, timestamp: number) {
    this.previousValue = value;
    this.previousDerivative = 0;
    this.previousTimestamp = timestamp;
  }

  filter(value: number, timestamp: number) {
    if (this.previousValue === null || !this.previousTimestamp) {
      this.seed(value, timestamp);
      return value;
    }

    const elapsed = Math.min(
      Math.max((timestamp - this.previousTimestamp) / 1000, 1 / 120),
      0.12,
    );
    const rawDerivative = (value - this.previousValue) / elapsed;
    const derivativeAlpha = smoothingFactor(this.derivativeCutoff, elapsed);
    const derivative =
      this.previousDerivative +
      derivativeAlpha * (rawDerivative - this.previousDerivative);
    const alpha = smoothingFactor(
      this.minCutoff + this.beta * Math.abs(derivative),
      elapsed,
    );
    const filteredValue =
      this.previousValue + alpha * (value - this.previousValue);

    this.previousValue = filteredValue;
    this.previousDerivative = derivative;
    this.previousTimestamp = timestamp;
    return filteredValue;
  }

  reset() {
    this.previousValue = null;
    this.previousDerivative = 0;
    this.previousTimestamp = 0;
  }
}

const vectorFromLandmarks = (from: HandLandmark, to: HandLandmark): Vector3 => ({
  x: from.x - to.x,
  y: from.y - to.y,
  z: (from.z ?? 0) - (to.z ?? 0),
});

const vectorScale = (vector: Vector3, scale: number): Vector3 => ({
  x: vector.x * scale,
  y: vector.y * scale,
  z: vector.z * scale,
});

const vectorAdd = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

const midpoint3 = (a: HandLandmark, b: HandLandmark): Vector3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
});

const estimatePalmCenter = (landmarks: HandLandmark[]): Vector3 => {
  const proximalCenter = midpoint3(landmarks[5], landmarks[17]);
  const distalCenter = midpoint3(landmarks[9], landmarks[13]);

  // MCP points alone move with finger splay. A small distal contribution keeps
  // the palm axis centered without letting the fingers pull the wrist anchor.
  return vectorAdd(
    vectorScale(proximalCenter, 0.72),
    vectorScale(distalCenter, 0.28),
  );
};

const estimateWristWidth = (
  palmLength: number,
  worldLandmarks?: HandLandmark[],
) => {
  const fallbackRatio = 0.74;

  if (worldLandmarks && worldLandmarks.length >= 18) {
    const worldProximalSpan = Math.hypot(
      (worldLandmarks[1].x ?? 0) - (worldLandmarks[17].x ?? 0),
      (worldLandmarks[1].y ?? 0) - (worldLandmarks[17].y ?? 0),
      (worldLandmarks[1].z ?? 0) - (worldLandmarks[17].z ?? 0),
    );
    const worldPalmCenter = estimatePalmCenter(worldLandmarks);
    const worldPalmLength = Math.hypot(
      worldPalmCenter.x - (worldLandmarks[0].x ?? 0),
      worldPalmCenter.y - (worldLandmarks[0].y ?? 0),
      worldPalmCenter.z - (worldLandmarks[0].z ?? 0),
    );
    const worldRatioRaw = worldProximalSpan / Math.max(worldPalmLength, 0.001);

    // Use the forearm direction as the scale axis. Unlike the transverse palm
    // span, it remains visible when the hand turns edge-on to the camera.
    if (
      worldRatioRaw >= 0.42 &&
      worldRatioRaw <= 0.82 &&
      worldPalmLength > 0.001
    ) {
      return palmLength * clamp(worldRatioRaw, 0.5, 0.7);
    }
  }

  // A side-on projection can collapse all transverse spans. Keep a stable
  // anatomy prior instead of letting those 2D points shrink the bracelet.
  return palmLength * fallbackRatio;
};

const resolveAnchorOffset = (
  palmWidth: number,
  palmLength: number,
  configuredOffset?: number,
) => {
  const widthToLength = clamp(palmWidth / Math.max(palmLength, 0.001), 0.45, 1.15);
  const automaticOffset = clamp(0.09 + widthToLength * 0.035, 0.1, 0.14);
  const manualCorrection =
    (configuredOffset ?? DEFAULT_ANCHOR_OFFSET) - DEFAULT_ANCHOR_OFFSET;

  return clamp(automaticOffset + manualCorrection, -0.08, 0.3);
};

const reorthogonalize = (
  armAxis: Vector3,
  lateralAxis: Vector3,
): { armAxis: Vector3; lateralAxis: Vector3; palmNormal: Vector3 } | null => {
  const normalizedArm = normalize3(armAxis);
  if (!normalizedArm) return null;

  const lateral = vectorAdd(
    lateralAxis,
    vectorScale(normalizedArm, -dot(lateralAxis, normalizedArm)),
  );
  const normalizedLateral = normalize3(lateral);
  if (!normalizedLateral) return null;

  const normalizedNormal = normalize3(
    cross(normalizedArm, normalizedLateral),
  );
  if (!normalizedNormal) return null;

  return {
    armAxis: normalizedArm,
    lateralAxis: normalizedLateral,
    palmNormal: normalizedNormal,
  };
};

export function calculateWristPose(
  landmarks: HandLandmark[],
  worldLandmarks?: HandLandmark[],
  handedness: HandednessLabel = "Unknown",
  options: WristPoseOptions = {},
): WristPose | null {
  if (landmarks.length < 18) return null;

  const wrist = landmarks[0];
  const indexMcp = landmarks[5];
  const pinkyMcp = landmarks[17];
  const palmCenter = estimatePalmCenter(landmarks);
  const sourceAspect = Math.max(options.sourceAspect ?? 4 / 3, 0.1);
  const palmDirection = {
    x: palmCenter.x - wrist.x,
    y: palmCenter.y - wrist.y,
  };
  const palmLength = Math.hypot(
    palmDirection.x * sourceAspect,
    palmDirection.y,
  );
  const palmWidth = Math.hypot(
    (indexMcp.x - pinkyMcp.x) * sourceAspect,
    indexMcp.y - pinkyMcp.y,
  );
  const wristWidth = estimateWristWidth(
    palmLength,
    worldLandmarks,
  );
  const anchorOffset = resolveAnchorOffset(
    palmWidth,
    palmLength,
    options.anchorOffset,
  );
  const visibilityValues = [wrist, indexMcp, pinkyMcp]
    .map((landmark) => landmark.visibility)
    .filter(
      (visibility): visibility is number =>
        visibility !== undefined && visibility > 0,
    );
  const confidence =
    visibilityValues.length > 0 ? average(visibilityValues) : 1;

  if (palmLength < 0.045 || palmWidth < 0.015) return null;

  const fallbackArm = normalize3({
    x: palmDirection.x * sourceAspect,
    y: palmDirection.y,
    z: 0,
  });
  const fallbackLateral = normalize3({
    x: (pinkyMcp.x - indexMcp.x) * sourceAspect,
    y: pinkyMcp.y - indexMcp.y,
    z: 0,
  });
  if (!fallbackArm || !fallbackLateral) return null;

  let armAxis = fallbackArm;
  let lateralAxis = fallbackLateral;
  let palmNormal = { x: 0, y: 0, z: 1 };
  let worldPalmWidth = palmWidth;
  let worldPalmLength = palmLength;
  let depth = 0;

  if (worldLandmarks && worldLandmarks.length >= 18) {
    const worldWrist = worldLandmarks[0];
    const worldIndexMcp = worldLandmarks[5];
    const worldPinkyMcp = worldLandmarks[17];
    const worldPalmCenter = estimatePalmCenter(worldLandmarks);
    const worldPalmVector = vectorFromLandmarks(
      worldPalmCenter as HandLandmark,
      worldWrist,
    );
    const worldBasis = reorthogonalize(
      worldPalmVector,
      vectorFromLandmarks(worldPinkyMcp, worldIndexMcp),
    );

    if (worldBasis) {
      armAxis = worldBasis.armAxis;
      lateralAxis = worldBasis.lateralAxis;
      palmNormal = worldBasis.palmNormal;
      worldPalmWidth = length3(
        vectorFromLandmarks(worldPinkyMcp, worldIndexMcp),
      );
      worldPalmLength = length3(worldPalmVector);
      const worldAnchor = vectorAdd(
        {
          x: worldWrist.x,
          y: worldWrist.y,
          z: worldWrist.z ?? 0,
        },
        vectorScale(worldBasis.armAxis, -length3(worldPalmVector) * anchorOffset),
      );
      depth = worldAnchor.z;
    }
  }

  return {
    x: wrist.x - (palmCenter.x - wrist.x) * anchorOffset,
    y: wrist.y - (palmCenter.y - wrist.y) * anchorOffset,
    depth,
    palmWidth,
    palmLength,
    wristWidth,
    worldPalmWidth,
    worldPalmLength,
    armAxis,
    lateralAxis,
    palmNormal,
    confidence,
    handedness,
  };
}

export function selectPrimaryHand(
  hands: HandLandmark[][],
  handedness: { categoryName?: string; score?: number }[][],
  previousHandedness: HandednessLabel = "Unknown",
) {
  if (hands.length === 0) return -1;

  const candidates = hands.map((landmarks, index) => {
    const category = handedness[index]?.[0];
    const label =
      category?.categoryName === "Left" || category?.categoryName === "Right"
        ? category.categoryName
        : "Unknown";
    const visibility = landmarks
      .slice(0, 18)
      .map((landmark) => landmark.visibility)
      .filter((value): value is number => value !== undefined);
    const confidence =
      category?.score ??
      (visibility.length > 0 ? average(visibility) : 1);
    const centerBias = 1 - Math.min(1, Math.abs((landmarks[0]?.x ?? 0.5) - 0.5));
    return {
      index,
      label,
      score: confidence * 0.8 + centerBias * 0.2,
    };
  });

  const matching = candidates.filter(
    (candidate) =>
      previousHandedness !== "Unknown" &&
      candidate.label === previousHandedness,
  );
  const pool = matching.length > 0 ? matching : candidates;
  return pool.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  ).index;
}

export class WristPoseSmoother {
  private settledFrames = 0;
  private lastTimestamp = 0;
  private pose: WristPose | null = null;
  private xFilter = new OneEuroFilter(1.35, 0.85);
  private yFilter = new OneEuroFilter(1.35, 0.85);
  private depthFilter = new OneEuroFilter(1.1, 0.32);
  private palmWidthFilter = new OneEuroFilter(1.6, 0.45);
  private palmLengthFilter = new OneEuroFilter(1.8, 0.55);
  private wristWidthFilter = new OneEuroFilter(1.8, 0.55);
  private worldPalmWidthFilter = new OneEuroFilter(1.8, 0.4);
  private worldPalmLengthFilter = new OneEuroFilter(1.8, 0.4);
  private armFilters = [
    new OneEuroFilter(2.2, 0.28),
    new OneEuroFilter(2.2, 0.28),
    new OneEuroFilter(2.2, 0.28),
  ];
  private lateralFilters = [
    new OneEuroFilter(2.2, 0.28),
    new OneEuroFilter(2.2, 0.28),
    new OneEuroFilter(2.2, 0.28),
  ];

  update(next: WristPose, timestamp: number): WristPose | null {
    if (!this.pose) {
      this.pose = next;
      this.xFilter.seed(next.x, timestamp);
      this.yFilter.seed(next.y, timestamp);
      this.depthFilter.seed(next.depth, timestamp);
      this.palmWidthFilter.seed(next.palmWidth, timestamp);
      this.palmLengthFilter.seed(next.palmLength, timestamp);
      this.wristWidthFilter.seed(next.wristWidth, timestamp);
      this.worldPalmWidthFilter.seed(next.worldPalmWidth, timestamp);
      this.worldPalmLengthFilter.seed(next.worldPalmLength, timestamp);
      this.armFilters.forEach((filter, index) =>
        filter.seed(
          [next.armAxis.x, next.armAxis.y, next.armAxis.z][index],
          timestamp,
        ),
      );
      this.lateralFilters.forEach((filter, index) =>
        filter.seed(
          [next.lateralAxis.x, next.lateralAxis.y, next.lateralAxis.z][index],
          timestamp,
        ),
      );
      this.lastTimestamp = timestamp;
      this.settledFrames = 1;
      return this.pose;
    }

    const filteredArm = {
      x: this.armFilters[0].filter(next.armAxis.x, timestamp),
      y: this.armFilters[1].filter(next.armAxis.y, timestamp),
      z: this.armFilters[2].filter(next.armAxis.z, timestamp),
    };
    const filteredLateral = {
      x: this.lateralFilters[0].filter(next.lateralAxis.x, timestamp),
      y: this.lateralFilters[1].filter(next.lateralAxis.y, timestamp),
      z: this.lateralFilters[2].filter(next.lateralAxis.z, timestamp),
    };
    const basis = reorthogonalize(filteredArm, filteredLateral);
    if (!basis) return this.pose;

    const basisContinuity =
      dot(basis.lateralAxis, this.pose.lateralAxis) +
      dot(basis.palmNormal, this.pose.palmNormal);
    if (basisContinuity < 0) {
      basis.lateralAxis = vectorScale(basis.lateralAxis, -1);
      basis.palmNormal = vectorScale(basis.palmNormal, -1);
    }

    this.pose = {
      x: this.xFilter.filter(next.x, timestamp),
      y: this.yFilter.filter(next.y, timestamp),
      depth: this.depthFilter.filter(next.depth, timestamp),
      palmWidth: this.palmWidthFilter.filter(next.palmWidth, timestamp),
      palmLength: this.palmLengthFilter.filter(next.palmLength, timestamp),
      wristWidth: this.wristWidthFilter.filter(next.wristWidth, timestamp),
      worldPalmWidth: this.worldPalmWidthFilter.filter(
        next.worldPalmWidth,
        timestamp,
      ),
      worldPalmLength: this.worldPalmLengthFilter.filter(
        next.worldPalmLength,
        timestamp,
      ),
      armAxis: basis.armAxis,
      lateralAxis: basis.lateralAxis,
      palmNormal: basis.palmNormal,
      confidence: next.confidence,
      handedness: next.handedness,
    };
    this.lastTimestamp = timestamp;
    this.settledFrames += 1;
    return this.settledFrames >= 2 ? this.pose : null;
  }

  hold(timestamp: number, maximumAge = 150): WristPose | null {
    if (!this.pose) return null;
    if (timestamp - this.lastTimestamp > maximumAge) {
      this.reset();
      return null;
    }
    return this.pose;
  }

  reset() {
    this.settledFrames = 0;
    this.lastTimestamp = 0;
    this.pose = null;
    this.xFilter.reset();
    this.yFilter.reset();
    this.depthFilter.reset();
    this.palmWidthFilter.reset();
    this.palmLengthFilter.reset();
    this.wristWidthFilter.reset();
    this.worldPalmWidthFilter.reset();
    this.worldPalmLengthFilter.reset();
    this.armFilters.forEach((filter) => filter.reset());
    this.lateralFilters.forEach((filter) => filter.reset());
  }
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const angleBetween = (a: Vector3, b: Vector3) =>
  Math.acos(clamp(dot(a, b), -1, 1));

export class WristScaleController {
  private wristWidth: number | null = null;
  private lastPose: WristPose | null = null;
  private lastTimestamp = 0;
  private stableSamples: number[] = [];
  private status: AutoFitStatus = "settling";

  update(pose: WristPose, timestamp: number): AutoFitResult {
    const measurement = Math.max(pose.wristWidth, 0.02);
    const rotationDelta = this.lastPose
      ? Math.max(
          angleBetween(pose.palmNormal, this.lastPose.palmNormal),
          angleBetween(pose.lateralAxis, this.lastPose.lateralAxis),
        )
      : 0;
    const palmScaleDelta = this.lastPose
      ? Math.abs(pose.palmLength - this.lastPose.palmLength) /
        Math.max(this.lastPose.palmLength, 0.001)
      : 0;
    const isDistanceChanging = palmScaleDelta > 0.025;
    const isRotating = rotationDelta > 0.035 && !isDistanceChanging;
    const elapsed = this.lastTimestamp
      ? clamp((timestamp - this.lastTimestamp) / 1000, 1 / 120, 0.12)
      : 1 / 60;

    this.lastPose = pose;
    this.lastTimestamp = timestamp;

    if (this.wristWidth === null) {
      this.wristWidth = measurement;
      this.stableSamples = [measurement];
      this.status = "settling";
      return { wristWidth: this.wristWidth, status: this.status };
    }

    if (isDistanceChanging) {
      // Palm length changing means the hand is moving toward or away from the
      // camera. Follow the current measurement quickly instead of waiting for
      // the stable sample window to catch up.
      this.stableSamples = [measurement];
      const alpha = clamp(elapsed * 20, 0.24, 0.72);
      this.wristWidth += (measurement - this.wristWidth) * alpha;
      this.status = "adapting";
    } else if (!isRotating) {
      this.stableSamples.push(measurement);
      if (this.stableSamples.length > 5) this.stableSamples.shift();

      const target = median(this.stableSamples);
      const difference = target - this.wristWidth;
      const alpha = clamp(elapsed * 10, 0.12, 0.42);
      this.wristWidth += difference * alpha;
      this.status =
        this.stableSamples.length < 4 || Math.abs(difference) < this.wristWidth * 0.018
          ? this.stableSamples.length < 6
            ? "settling"
            : "locked"
          : "adapting";
    } else {
      // A rotating hand changes projected widths even when its real size does
      // not. Keep the last stable diameter until the pose settles again.
      this.status = "locked";
    }

    return { wristWidth: this.wristWidth, status: this.status };
  }

  hold(): AutoFitResult {
    return { wristWidth: this.wristWidth, status: this.status };
  }

  reset() {
    this.wristWidth = null;
    this.lastPose = null;
    this.lastTimestamp = 0;
    this.stableSamples = [];
    this.status = "settling";
  }
}

export type GravityVector = Vector3;

export function projectGravityToWristPlane(
  pose: WristPose,
  gravity: GravityVector,
) {
  const alongArm = dot(gravity, pose.armAxis);
  const projected = vectorAdd(
    gravity,
    vectorScale(pose.armAxis, -alongArm),
  );
  const normalizedProjected = normalize3(projected);
  if (!normalizedProjected) {
    return { targetRoll: 0, alongArm };
  }

  return {
    targetRoll: Math.atan2(
      dot(normalizedProjected, pose.palmNormal),
      dot(normalizedProjected, pose.lateralAxis),
    ),
    alongArm,
  };
}

export class BraceletPhysics {
  private roll = 0;
  private rollVelocity = 0;
  private slide = 0;
  private slideVelocity = 0;
  private targetRoll = 0;
  private hasTargetRoll = false;

  update(nextTargetRoll: number, alongArm: number, elapsedSeconds: number) {
    const deltaTime = clamp(elapsedSeconds, 1 / 120, 1 / 24);
    if (!this.hasTargetRoll) {
      this.targetRoll = nextTargetRoll;
      this.hasTargetRoll = true;
    } else {
      // Unwrap the measured angle so crossing -PI/PI cannot cause a full turn.
      const targetDelta = Math.atan2(
        Math.sin(nextTargetRoll - this.targetRoll),
        Math.cos(nextTargetRoll - this.targetRoll),
      );
      this.targetRoll += clamp(targetDelta, -0.55, 0.55);
    }

    // Critical damping keeps the bracelet responsive without rotating past
    // the gravity target when the wrist turns quickly.
    const rollError = this.targetRoll - this.roll;
    const rollAcceleration = rollError * 36 - this.rollVelocity * 12;
    this.rollVelocity += rollAcceleration * deltaTime;
    this.roll += this.rollVelocity * deltaTime;

    const targetSlide = clamp(alongArm * 0.014, -0.012, 0.012);
    const slideAcceleration = (targetSlide - this.slide) * 18 - this.slideVelocity * 6;
    this.slideVelocity += slideAcceleration * deltaTime;
    this.slide += this.slideVelocity * deltaTime;

    return { roll: this.roll, slide: this.slide };
  }

  reset() {
    this.roll = 0;
    this.rollVelocity = 0;
    this.slide = 0;
    this.slideVelocity = 0;
    this.targetRoll = 0;
    this.hasTargetRoll = false;
  }
}

type DrawOptions = {
  tint: string;
  opacity: number;
  rotationOffset?: number;
  widthRatio?: number;
  layer?: "all" | "top" | "bottom";
};

const HAND_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
] as const;

const distance = (a: HandLandmark, b: HandLandmark) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const average = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const smoothingFactor = (cutoff: number, elapsed: number) => {
  const timeConstant = 1 / (2 * Math.PI * Math.max(cutoff, 0.001));
  return 1 / (1 + timeConstant / elapsed);
};

type CoreVector3 = {
  x: number;
  y: number;
  z: number;
};

const subtract = (from: HandLandmark, to: HandLandmark): CoreVector3 => ({
  x: from.x - to.x,
  y: from.y - to.y,
  z: (from.z ?? 0) - (to.z ?? 0),
});

const length3 = (vector: CoreVector3) =>
  Math.hypot(vector.x, vector.y, vector.z);

const normalize3 = (vector: CoreVector3): CoreVector3 | null => {
  const length = length3(vector);
  if (length < 0.00001) return null;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
};

const dot = (a: CoreVector3, b: CoreVector3) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: CoreVector3, b: CoreVector3): CoreVector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export function calculateWristTransform(
  landmarks: HandLandmark[],
  worldLandmarks?: HandLandmark[],
): WristTransform | null {
  if (landmarks.length < 18) return null;

  const wrist = landmarks[0];
  const indexMcp = landmarks[5];
  const pinkyMcp = landmarks[17];
  const palmCenter = estimatePalmCenter(landmarks);
  const palmDirection = {
    x: palmCenter.x - wrist.x,
    y: palmCenter.y - wrist.y,
  };
  const palmLength = Math.hypot(palmDirection.x, palmDirection.y);
  const palmWidth = distance(indexMcp, pinkyMcp);
  const width = Math.max(palmWidth * 0.94, palmLength * 0.54);
  const anchorOffset = resolveAnchorOffset(palmWidth, palmLength);
  const fallbackRotation =
    Math.atan2(palmDirection.y, palmDirection.x) + Math.PI / 2;
  let heightRatio = 0.34;
  let patternPhase = 0;
  let patternPhaseConfidence = 0;
  let palmFacing = 0;
  let palmSide: WristTransform["palmSide"] = "top";

  if (worldLandmarks && worldLandmarks.length >= 18) {
    const worldWrist = worldLandmarks[0];
    const worldIndexMcp = worldLandmarks[5];
    const worldPinkyMcp = worldLandmarks[17];
    const worldPalmCenter = estimatePalmCenter(worldLandmarks);
    const armAxis = normalize3(
      vectorFromLandmarks(worldPalmCenter as HandLandmark, worldWrist),
    );
    const rawLateralAxis = subtract(worldPinkyMcp, worldIndexMcp);

    if (armAxis) {
      const lateralAxis = normalize3({
        x: rawLateralAxis.x - armAxis.x * dot(rawLateralAxis, armAxis),
        y: rawLateralAxis.y - armAxis.y * dot(rawLateralAxis, armAxis),
        z: rawLateralAxis.z - armAxis.z * dot(rawLateralAxis, armAxis),
      });

      if (lateralAxis) {
        const palmNormal = normalize3(cross(armAxis, lateralAxis));

        // The forearm controls the base projection. When the hand rolls
        // edge-on, also compress the ring so it cannot read as a full circle.
        const baseHeightRatio = clamp(
          0.1 + Math.abs(armAxis.z) * 0.82,
          0.1,
          0.92,
        );
        heightRatio = baseHeightRatio;

        if (palmNormal) {
          palmFacing = palmNormal.z;
          palmSide = palmNormal.z >= 0 ? "top" : "bottom";
          const sideOnCompression = 0.18 + Math.abs(palmNormal.z) * 0.82;
          heightRatio = clamp(
            baseHeightRatio * sideOnCompression,
            0.08,
            0.92,
          );

          // Keep the ring's screen rotation 2D-stable. The 3D normal only
          // drives where the asymmetric decoration sits around the ring.
          const screenMajorAxis = {
            x: Math.cos(fallbackRotation),
            y: Math.sin(fallbackRotation),
            z: 0,
          };
          const majorAxis = normalize3({
            x:
              screenMajorAxis.x -
              armAxis.x * dot(screenMajorAxis, armAxis),
            y:
              screenMajorAxis.y -
              armAxis.y * dot(screenMajorAxis, armAxis),
            z:
              screenMajorAxis.z -
              armAxis.z * dot(screenMajorAxis, armAxis),
          });

          if (majorAxis) {
            const rawMinorAxis = normalize3(cross(armAxis, majorAxis));
            const screenMinorAxis = {
              x: -Math.sin(fallbackRotation),
              y: Math.cos(fallbackRotation),
              z: 0,
            };
            const minorAxis =
              rawMinorAxis && dot(rawMinorAxis, screenMinorAxis) < 0
                ? {
                    x: -rawMinorAxis.x,
                    y: -rawMinorAxis.y,
                    z: -rawMinorAxis.z,
                  }
                : rawMinorAxis;

            if (minorAxis) {
              patternPhase = Math.atan2(
                dot(palmNormal, minorAxis),
                dot(palmNormal, majorAxis),
              );
              patternPhaseConfidence = 1;
            }
          }
        }
      }
    }
  }

  const visibilityValues = [wrist, indexMcp, pinkyMcp]
    .map((landmark) => landmark.visibility)
    .filter((visibility): visibility is number => visibility !== undefined && visibility > 0);
  const confidence =
    visibilityValues.length > 0 ? average(visibilityValues) : 1;

  if (palmLength < 0.045) return null;

  return {
    x: wrist.x - (palmCenter.x - wrist.x) * anchorOffset,
    y: wrist.y - (palmCenter.y - wrist.y) * anchorOffset,
    width,
    rotation: fallbackRotation,
    patternPhase,
    patternPhaseConfidence,
    heightRatio,
    confidence,
    palmSide,
    palmFacing,
  };
}

export function drawBracelet(
  context: CanvasRenderingContext2D,
  transform: WristTransform,
  options: DrawOptions,
) {
  const canvasWidth = context.canvas.width;
  const canvasHeight = context.canvas.height;
  const widthRatio = options.widthRatio ?? 1.16;
  const rotationOffset = options.rotationOffset ?? 0;
  const layer = options.layer ?? "all";
  const renderWidth = transform.width * canvasWidth * widthRatio;
  const renderHeight =
    renderWidth * clamp(transform.heightRatio, 0.1, 0.92);
  const radiusX = renderWidth / 2;
  const radiusY = renderHeight / 2;
  const bandWidth = clamp(renderWidth * 0.105, 5, 24);

  context.save();
  context.globalAlpha = options.opacity;
  context.translate(transform.x * canvasWidth, transform.y * canvasHeight);
  context.rotate(transform.rotation + rotationOffset);
  if (layer !== "all") {
    // The metal stroke extends past the ellipse radii. Padding the half-ring
    // clip keeps that outer edge round instead of slicing it into a frame.
    const clipPadding = Math.max(bandWidth * 1.5, 8);
    const seamOverlap = 1;
    context.beginPath();
    context.rect(
      -radiusX - clipPadding,
      layer === "top" ? -radiusY - clipPadding : -seamOverlap,
      renderWidth + clipPadding * 2,
      radiusY + clipPadding + seamOverlap,
    );
    context.clip();
  }
  drawMetalRing(
    context,
    radiusX,
    radiusY,
    bandWidth,
    options.tint,
    transform.patternPhase,
  );
  context.restore();
}

function drawMetalRing(
  context: CanvasRenderingContext2D,
  radiusX: number,
  radiusY: number,
  bandWidth: number,
  tint: string,
  patternPhase: number,
) {
  const darkTint = mixHex(tint, "#101010", 0.62);
  const lightTint = mixHex(tint, "#fff8dc", 0.56);
  const surface = context.createRadialGradient(
    0,
    0,
    Math.min(radiusX, radiusY) * 0.24,
    0,
    0,
    Math.max(radiusX, radiusY),
  );
  surface.addColorStop(0, lightTint);
  surface.addColorStop(0.68, tint);
  surface.addColorStop(1, darkTint);

  context.lineCap = "round";
  context.lineWidth = bandWidth * 1.36;
  context.strokeStyle = darkTint;
  strokeEllipse(context, radiusX, radiusY);

  context.lineWidth = bandWidth;
  context.strokeStyle = surface;
  strokeEllipse(context, radiusX, radiusY);

  // A single decorative station makes the otherwise symmetric loop readable
  // as it rotates, while remaining attached to the bracelet's local axis.
  drawPaveStation(context, radiusX, radiusY, bandWidth, tint, patternPhase);
}

function drawPaveStation(
  context: CanvasRenderingContext2D,
  radiusX: number,
  radiusY: number,
  bandWidth: number,
  tint: string,
  patternPhase: number,
) {
  const startAngle = patternPhase - Math.PI * 0.82;
  const endAngle = patternPhase - Math.PI * 0.33;
  const darkTint = mixHex(tint, "#17130f", 0.68);
  const railTint = mixHex(tint, "#fff7df", 0.7);
  const stoneCount = 6;
  const stoneSize = clamp(bandWidth * 0.31, 2.1, 6.4);

  context.save();

  // The darker frame reads as a clasp/setting, so there is one clear point
  // on the circumference even when the stones are too small to resolve.
  context.lineCap = "butt";
  context.lineWidth = bandWidth * 1.08;
  context.strokeStyle = darkTint;
  strokeEllipse(context, radiusX, radiusY, startAngle, endAngle);

  context.lineWidth = bandWidth * 0.78;
  context.strokeStyle = railTint;
  strokeEllipse(context, radiusX, radiusY, startAngle, endAngle);

  for (let index = 0; index < stoneCount; index += 1) {
    const progress = (index + 0.5) / stoneCount;
    const angle = startAngle + (endAngle - startAngle) * progress;
    const x = Math.cos(angle) * radiusX;
    const y = Math.sin(angle) * radiusY;
    const tangent = Math.atan2(
      Math.cos(angle) * radiusY,
      -Math.sin(angle) * radiusX,
    );

    context.save();
    context.translate(x, y);
    context.rotate(tangent);

    const stone = context.createRadialGradient(
      -stoneSize * 0.28,
      -stoneSize * 0.34,
      stoneSize * 0.06,
      0,
      0,
      stoneSize,
    );
    stone.addColorStop(0, "#ffffff");
    stone.addColorStop(0.38, "#dff3ff");
    stone.addColorStop(1, "#7895a8");

    context.fillStyle = stone;
    context.strokeStyle = mixHex(tint, "#332920", 0.58);
    context.lineWidth = Math.max(0.75, stoneSize * 0.16);
    context.beginPath();
    context.moveTo(0, -stoneSize);
    context.lineTo(stoneSize * 0.72, 0);
    context.lineTo(0, stoneSize);
    context.lineTo(-stoneSize * 0.72, 0);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
  }

  const claspAngle = endAngle + Math.PI * 0.22;
  const claspX = Math.cos(claspAngle) * radiusX;
  const claspY = Math.sin(claspAngle) * radiusY;
  const claspTangent = Math.atan2(
    Math.cos(claspAngle) * radiusY,
    -Math.sin(claspAngle) * radiusX,
  );

  context.save();
  context.translate(claspX, claspY);
  context.rotate(claspTangent);
  context.fillStyle = darkTint;
  context.fillRect(-bandWidth * 0.22, -bandWidth * 0.56, bandWidth * 0.44, bandWidth * 1.12);
  context.fillStyle = mixHex(tint, "#fff7df", 0.42);
  context.fillRect(-bandWidth * 0.1, -bandWidth * 0.48, bandWidth * 0.2, bandWidth * 0.96);
  context.restore();

  context.restore();
}

function strokeEllipse(
  context: CanvasRenderingContext2D,
  radiusX: number,
  radiusY: number,
  startAngle = 0,
  endAngle = Math.PI * 2,
) {
  context.beginPath();
  context.ellipse(0, 0, radiusX, radiusY, 0, startAngle, endAngle);
  context.stroke();
}

function mixHex(source: string, target: string, ratio: number) {
  const sourceRgb = parseHex(source);
  const targetRgb = parseHex(target);
  if (!sourceRgb || !targetRgb) return source;

  const mix = (from: number, to: number) =>
    Math.round(from + (to - from) * ratio);
  return `rgb(${mix(sourceRgb[0], targetRgb[0])} ${mix(
    sourceRgb[1],
    targetRgb[1],
  )} ${mix(sourceRgb[2], targetRgb[2])})`;
}

function parseHex(color: string): [number, number, number] | null {
  const value = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;

  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

export function eraseWristOcclusion(
  context: CanvasRenderingContext2D,
  landmarks: HandLandmark[],
) {
  if (landmarks.length < 18) return;

  const wrist = landmarks[0];
  const indexMcp = landmarks[5];
  const pinkyMcp = landmarks[17];
  const palmCenter = {
    x: (indexMcp.x + pinkyMcp.x) / 2,
    y: (indexMcp.y + pinkyMcp.y) / 2,
  };
  const palmWidth = distance(indexMcp, pinkyMcp);
  const palmLength = Math.hypot(
    palmCenter.x - wrist.x,
    palmCenter.y - wrist.y,
  );

  if (palmWidth === 0 || palmLength === 0) return;

  const lateral = {
    x: (pinkyMcp.x - indexMcp.x) / palmWidth,
    y: (pinkyMcp.y - indexMcp.y) / palmWidth,
  };
  const towardPalm = {
    x: (palmCenter.x - wrist.x) / palmLength,
    y: (palmCenter.y - wrist.y) / palmLength,
  };
  const canvasWidth = context.canvas.width;
  const canvasHeight = context.canvas.height;
  const toCanvasPoint = (point: { x: number; y: number }) => ({
    x: point.x * canvasWidth,
    y: point.y * canvasHeight,
  });
  const pointFromWrist = (lateralOffset: number, palmOffset: number) =>
    toCanvasPoint({
      x:
        wrist.x +
        lateral.x * lateralOffset +
        towardPalm.x * palmOffset,
      y:
        wrist.y +
        lateral.y * lateralOffset +
        towardPalm.y * palmOffset,
    });

  // Keep only the wrist/palm centre as an occluder. A wider mask cuts the
  // outside of the rear arc and makes the bracelet look boxed in.
  const halfWidth = palmWidth * 0.48;
  const armOffset = -palmLength * 0.2;
  const palmOffset = palmLength * 0.56;
  const armLeft = pointFromWrist(-halfWidth, armOffset);
  const armRight = pointFromWrist(halfWidth, armOffset);
  const palmRight = pointFromWrist(halfWidth * 1.08, palmOffset);
  const palmLeft = pointFromWrist(-halfWidth * 1.08, palmOffset);

  context.save();
  context.globalCompositeOperation = "destination-out";
  context.beginPath();
  context.moveTo(armLeft.x, armLeft.y);
  context.lineTo(armRight.x, armRight.y);
  context.lineTo(palmRight.x, palmRight.y);
  context.lineTo(palmLeft.x, palmLeft.y);
  context.closePath();
  context.fill();
  context.restore();
}

export function drawHandLandmarks(
  context: CanvasRenderingContext2D,
  hands: HandLandmark[][],
) {
  const width = context.canvas.width;
  const height = context.canvas.height;

  context.save();
  context.lineWidth = Math.max(2, width * 0.003);
  context.strokeStyle = "#9ab9aa";
  context.fillStyle = "#f1efe9";

  for (const landmarks of hands) {
    for (const [from, to] of HAND_CONNECTIONS) {
      const start = landmarks[from];
      const end = landmarks[to];
      if (!start || !end) continue;

      context.beginPath();
      context.moveTo(start.x * width, start.y * height);
      context.lineTo(end.x * width, end.y * height);
      context.stroke();
    }

    for (const landmark of landmarks) {
      context.beginPath();
      context.arc(
        landmark.x * width,
        landmark.y * height,
        Math.max(3, width * 0.006),
        0,
        Math.PI * 2,
      );
      context.fill();
    }
  }

  context.restore();
}
