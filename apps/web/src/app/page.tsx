"use client";

import {
  Camera,
  ChartNoAxesColumn,
  Check,
  Download,
  ExternalLink,
  Hand,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AutoFitStatus,
  HandCountStabilizer,
  type HandLandmarkerResult,
  WristScaleController,
  BraceletPhysics,
  calculateWristPose,
  projectGravityToWristPlane,
  selectPrimaryHand,
  WristPosePredictor,
  WristPoseSmoother,
  type HandednessLabel,
  type HandLandmark,
  type Vector3,
  type WristPose,
  type WristAnchorMode,
} from "@/lib/tryon-core";
import {
  calculateRate,
  classifyDevice,
  createTryOnAnalytics,
  normalizeTryOnAnalytics,
  recordTryOnEvent,
  summarizeProductAnalytics,
  type AnalyticsEventName,
  type TryOnAnalyticsSnapshot,
} from "@/lib/tryon-analytics";
import { configureMediaPipeRuntimeLogging } from "@/lib/mediapipe-runtime";
import {
  calculateOrientationConfidence,
  ThreeTryOnRenderer,
} from "@/lib/three-tryon-renderer";

type CameraStatus = "idle" | "loading" | "ready" | "tracking" | "error";

type ErrorRecoveryKind =
  | "camera-permission"
  | "camera-unavailable"
  | "model-loading"
  | "tracking-runtime";

type ProductFitConfig = {
  anchorMode: WristAnchorMode;
  autoFitEnabled: boolean;
  braceletFitRatio: number;
  braceletAspectRatio: number;
  wristProxyWidthRatio: number;
  rotationSmoothingEnabled: boolean;
  wristToPalmRatio: number;
  minimumScale: number;
  maximumScale: number;
  anchorOffset: number;
  manualScale: number;
};

type DebugFrame = {
  landmarks: HandLandmark[];
  pose: WristPose | null;
  orientationConfidence: number | null;
  sourceAspect: number;
  stageAspect: number;
};

type DebugPerformanceStats = {
  inferenceMs: number | null;
  trackingFrameMs: number | null;
  smoothingMs: number | null;
  renderMs: number | null;
  fps: number | null;
};

type PerformanceMetric = Exclude<keyof DebugPerformanceStats, "fps">;

type PerformanceAccumulator = {
  totals: Record<PerformanceMetric, number>;
  counts: Record<PerformanceMetric, number>;
  renderLoopFrames: number;
  windowStartedAt: number;
};

type HandTrackingWorkerResponse =
  | { type: "ready" }
  | {
      type: "result";
      result: HandLandmarkerResult;
      sessionId: number;
      timestamp: number;
      videoTime: number;
      inferenceMs: number;
    }
  | { type: "error"; message: string; sessionId?: number };

type DetectionLoop = (metadata?: VideoFrameCallbackMetadata) => void;

type Product = {
  id: string;
  name: string;
  material: string;
  color: string;
  accent: string;
  tint: string;
  fit: ProductFitConfig;
  buyUrl: string;
};

const makeFitConfig = (braceletFitRatio: number): ProductFitConfig => ({
  anchorMode: "wrist",
  autoFitEnabled: true,
  braceletFitRatio,
  braceletAspectRatio: 0.76,
  wristProxyWidthRatio: 0.88,
  rotationSmoothingEnabled: true,
  wristToPalmRatio: 0.74,
  minimumScale: 0.08,
  maximumScale: 0.75,
  anchorOffset: 0.17,
  manualScale: 0.22,
});

const products: Product[] = [
  {
    id: "aurora-gold",
    name: "Aurora",
    material: "18K 黄金",
    color: "金色",
    accent: "#e8f4f4",
    tint: "#d9a441",
    fit: makeFitConfig(1.06),
    buyUrl: "https://example.com/products/aurora",
  },
  {
    id: "mist-silver",
    name: "Mist",
    material: "925 银",
    color: "银色",
    accent: "#e5f1f4",
    tint: "#d8e0e5",
    fit: makeFitConfig(1.05),
    buyUrl: "https://example.com/products/mist",
  },
  {
    id: "rose-line",
    name: "Rose Line",
    material: "玫瑰金",
    color: "玫瑰金",
    accent: "#f2dfd9",
    tint: "#d6957e",
    fit: makeFitConfig(1.06),
    buyUrl: "https://example.com/products/rose-line",
  },
  {
    id: "onyx-link",
    name: "Onyx Link",
    material: "黑金",
    color: "黑色",
    accent: "#a6bac7",
    tint: "#4a5059",
    fit: makeFitConfig(1.06),
    buyUrl: "https://example.com/products/onyx-link",
  },
  {
    id: "pearl-edge",
    name: "Pearl Edge",
    material: "珍珠白",
    color: "白色",
    accent: "#f8f0dc",
    tint: "#eee4d1",
    fit: makeFitConfig(1.05),
    buyUrl: "https://example.com/products/pearl-edge",
  },
];

const statusLabels: Record<CameraStatus, string> = {
  idle: "相机未启动",
  loading: "正在准备",
  ready: "等待手腕",
  tracking: "3D 识别中",
  error: "需要检查",
};

const errorRecoveryCopy: Record<
  ErrorRecoveryKind,
  { actionLabel: string; hint: string }
> = {
  "camera-permission": {
    actionLabel: "重新请求权限",
    hint: "请在浏览器地址栏或系统设置中允许摄像头，然后重新启动。",
  },
  "camera-unavailable": {
    actionLabel: "重新检测相机",
    hint: "没有拿到可用摄像头，请检查浏览器支持、设备占用或 HTTPS 地址。",
  },
  "model-loading": {
    actionLabel: "重试加载模型",
    hint: "手部模型需要从网络加载。请切换网络或刷新后重试。",
  },
  "tracking-runtime": {
    actionLabel: "重新启动识别",
    hint: "识别已停止，画面不会保留旧手链位置。可重新启动恢复。",
  },
};

const autoFitStatusLabels: Record<AutoFitStatus, string> = {
  settling: "稳定测量中",
  locked: "尺寸已锁定",
  adapting: "自动调整中",
};

const defaultGravity: Vector3 = { x: 0, y: 1, z: 0 };
const rigidBraceletPhysics = { roll: 0, slide: 0 };
const fitConfigStorageKey = "ar-jewelry:product-fit-configs:v2";
const analyticsStorageKey = "ar-jewelry:tryon-analytics:v1";
const hydrationAnalyticsTimestamp = "1970-01-01T00:00:00.000Z";
const handLandmarkerModelAssetPath =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const mediaPipeWasmPath =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const handLandmarkerOptions = {
  runningMode: "VIDEO" as const,
  numHands: 1,
  minHandDetectionConfidence: 0.55,
  minHandPresenceConfidence: 0.55,
  minTrackingConfidence: 0.55,
};
const minimumInferenceIntervalMs = 1000 / 30;
const inferenceFrameWidth = 480;
const inferenceFrameHeight = 360;
const poseVisibilityGraceMs = 80;
const poseVisibilityFadeMs = 160;
const performanceUpdateIntervalMs = 1000;
const modelLoadErrorMessage = "手部模型加载失败，请检查网络后重试。";

const emptyPerformanceStats = (): DebugPerformanceStats => ({
  inferenceMs: null,
  trackingFrameMs: null,
  smoothingMs: null,
  renderMs: null,
  fps: null,
});

const createPerformanceAccumulator = (
  windowStartedAt = 0,
): PerformanceAccumulator => ({
  totals: {
    inferenceMs: 0,
    trackingFrameMs: 0,
    smoothingMs: 0,
    renderMs: 0,
  },
  counts: {
    inferenceMs: 0,
    trackingFrameMs: 0,
    smoothingMs: 0,
    renderMs: 0,
  },
  renderLoopFrames: 0,
  windowStartedAt,
});

const recordPerformanceMetric = (
  accumulator: PerformanceAccumulator,
  metric: PerformanceMetric,
  durationMs: number,
) => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  accumulator.totals[metric] += durationMs;
  accumulator.counts[metric] += 1;
};

const averagePerformanceMetric = (
  accumulator: PerformanceAccumulator,
  metric: PerformanceMetric,
) =>
  accumulator.counts[metric] > 0
    ? accumulator.totals[metric] / accumulator.counts[metric]
    : null;

const formatTiming = (value: number | null, digits = 1) =>
  value === null ? "--" : `${value.toFixed(digits)} ms`;

const formatFps = (value: number | null) =>
  value === null ? "--" : value.toFixed(1);

const getErrorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const getErrorName = (error: unknown) =>
  typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";

const recoveryKindFromMessage = (message: string): ErrorRecoveryKind =>
  /模型|网络|wasm|fetch|load/i.test(message)
    ? "model-loading"
    : "tracking-runtime";

const formatRate = (rate: number | null) => (rate === null ? "--" : `${rate}%`);

function resolveStartupError(error: unknown): {
  message: string;
  recoveryKind: ErrorRecoveryKind;
} {
  const name = getErrorName(error);
  const message = getErrorText(error, "摄像头启动失败，请重试");

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return {
      message: "摄像头权限被拒绝",
      recoveryKind: "camera-permission",
    };
  }

  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    message.includes("不支持摄像头")
  ) {
    return {
      message,
      recoveryKind: "camera-unavailable",
    };
  }

  return {
    message,
    recoveryKind: recoveryKindFromMessage(message),
  };
}

const clampNumber = (
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;

function normalizeFitConfig(
  base: ProductFitConfig,
  value: unknown,
): ProductFitConfig {
  if (!value || typeof value !== "object") return { ...base };
  const stored = value as Partial<ProductFitConfig>;
  const minimumScale = clampNumber(
    stored.minimumScale,
    0.04,
    0.45,
    base.minimumScale,
  );
  const maximumScale = Math.max(
    minimumScale + 0.01,
    clampNumber(stored.maximumScale, 0.1, 1.2, base.maximumScale),
  );
  return {
    anchorMode:
      stored.anchorMode === "palm-root" || stored.anchorMode === "wrist"
        ? stored.anchorMode
        : base.anchorMode,
    autoFitEnabled:
      typeof stored.autoFitEnabled === "boolean"
        ? stored.autoFitEnabled
        : base.autoFitEnabled,
    braceletFitRatio: clampNumber(
      stored.braceletFitRatio,
      1,
      1.15,
      base.braceletFitRatio,
    ),
    braceletAspectRatio: clampNumber(
      stored.braceletAspectRatio,
      0.6,
      1,
      base.braceletAspectRatio,
    ),
    wristProxyWidthRatio: clampNumber(
      stored.wristProxyWidthRatio,
      0.75,
      0.95,
      base.wristProxyWidthRatio,
    ),
    rotationSmoothingEnabled:
      typeof stored.rotationSmoothingEnabled === "boolean"
        ? stored.rotationSmoothingEnabled
        : base.rotationSmoothingEnabled,
    wristToPalmRatio: clampNumber(
      stored.wristToPalmRatio,
      0.5,
      1,
      base.wristToPalmRatio,
    ),
    minimumScale,
    maximumScale,
    anchorOffset: clampNumber(
      stored.anchorOffset,
      0.04,
      0.3,
      base.anchorOffset,
    ),
    manualScale: clampNumber(
      stored.manualScale,
      minimumScale,
      maximumScale,
      base.manualScale,
    ),
  };
}

const defaultProductConfigs = Object.fromEntries(
  products.map((product) => [product.id, product.fit]),
) as Record<string, ProductFitConfig>;

function restoreProductConfigs() {
  const restored = { ...defaultProductConfigs };
  try {
    const raw = window.localStorage.getItem(fitConfigStorageKey);
    if (!raw) return restored;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    products.forEach((product) => {
      restored[product.id] = normalizeFitConfig(
        product.fit,
        parsed[product.id],
      );
    });
  } catch {
    return restored;
  }
  return restored;
}

function restoreAnalyticsSnapshot(): TryOnAnalyticsSnapshot {
  try {
    const raw = window.localStorage.getItem(analyticsStorageKey);
    return normalizeTryOnAnalytics(raw ? JSON.parse(raw) : null);
  } catch {
    return createTryOnAnalytics();
  }
}

function mapPoseToStage(
  pose: ReturnType<typeof calculateWristPose>,
  sourceAspect: number,
  stageAspect: number,
) {
  if (!pose) return null;

  let x = pose.x;
  let y = pose.y;
  if (sourceAspect > stageAspect) {
    x = 0.5 + (pose.x - 0.5) * (sourceAspect / stageAspect);
  } else if (sourceAspect < stageAspect) {
    y = 0.5 + (pose.y - 0.5) * (stageAspect / sourceAspect);
  }

  return { ...pose, x, y };
}

function mapPointToStage(
  point: HandLandmark,
  sourceAspect: number,
  stageAspect: number,
) {
  let x = point.x;
  let y = point.y;
  if (sourceAspect > stageAspect) {
    x = 0.5 + (point.x - 0.5) * (sourceAspect / stageAspect);
  } else if (sourceAspect < stageAspect) {
    y = 0.5 + (point.y - 0.5) * (stageAspect / sourceAspect);
  }
  return { x, y };
}

export default function Home() {
  const [selectedProductId, setSelectedProductId] = useState(products[0].id);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [errorRecoveryKind, setErrorRecoveryKind] =
    useState<ErrorRecoveryKind>("tracking-runtime");
  const [captureMessage, setCaptureMessage] = useState("");
  const [detectedHands, setDetectedHands] = useState(0);
  const [autoFitStatus, setAutoFitStatus] =
    useState<AutoFitStatus>("settling");
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [physicsEnabled, setPhysicsEnabled] = useState(false);
  const [positionFilterEnabled, setPositionFilterEnabled] = useState(true);
  const [productConfigs, setProductConfigs] =
    useState<Record<string, ProductFitConfig>>(() => ({
      ...defaultProductConfigs,
    }));
  const [analytics, setAnalytics] = useState<TryOnAnalyticsSnapshot>(() =>
    createTryOnAnalytics(hydrationAnalyticsTimestamp),
  );
  const [localStateRestored, setLocalStateRestored] = useState(false);
  const [debugFrame, setDebugFrame] = useState<DebugFrame | null>(null);
  const [debugPerformance, setDebugPerformance] =
    useState<DebugPerformanceStats>(emptyPerformanceStats);

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayHostRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<{
    detectForVideo: (video: HTMLVideoElement, timestamp: number) => HandLandmarkerResult;
    close?: () => void;
  } | null>(null);
  const handTrackingWorkerRef = useRef<Worker | null>(null);
  const workerBusyRef = useRef(false);
  const trackingSessionRef = useRef(0);
  const renderAnimationFrameRef = useRef<number | null>(null);
  const detectionTimeoutRef = useRef<number | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const renderLoopRef = useRef<(timestamp: number) => void>(() => undefined);
  const detectionLoopRef = useRef<DetectionLoop>(() => undefined);
  const lastVideoTimeRef = useRef(-1);
  const lastFrameTimestampRef = useRef(0);
  const renderPoseRef = useRef<WristPose | null>(null);
  const poseVisibleRef = useRef(false);
  const lastVisiblePoseTimestampRef = useRef(0);
  const renderedPoseRef = useRef(false);
  const trackedThisSessionRef = useRef(false);
  const pageViewRecordedRef = useRef(false);
  const isActiveRef = useRef(false);
  const trackingRef = useRef(false);
  const detectedHandsRef = useRef(0);
  const handCountStabilizerRef = useRef(new HandCountStabilizer());
  const selectedProductRef = useRef(products[0]);
  const calibrationRef = useRef<ProductFitConfig>(products[0].fit);
  const calibrationOpenRef = useRef(false);
  const physicsEnabledRef = useRef(false);
  const positionFilterEnabledRef = useRef(true);
  const lastDebugUpdateRef = useRef(0);
  const performanceAccumulatorRef = useRef(createPerformanceAccumulator());
  const performanceSnapshotRef = useRef<DebugPerformanceStats>(
    emptyPerformanceStats(),
  );
  const selectedHandRef = useRef<HandednessLabel>("Unknown");
  const poseSmootherRef = useRef(new WristPoseSmoother());
  const posePredictorRef = useRef(new WristPosePredictor());
  const scaleControllerRef = useRef(new WristScaleController());
  const autoFitStatusRef = useRef<AutoFitStatus>("settling");
  const physicsRef = useRef(new BraceletPhysics());
  const rendererRef = useRef<ThreeTryOnRenderer | null>(null);
  const gravityRef = useRef<Vector3>(defaultGravity);
  const motionHandlerRef = useRef<((event: DeviceMotionEvent) => void) | null>(
    null,
  );

  const selectedProduct =
    products.find((product) => product.id === selectedProductId) ?? products[0];
  const calibration =
    productConfigs[selectedProductId] ?? selectedProduct.fit;
  const anchorCorrectionPercent = Math.round(
    (calibration.anchorOffset - 0.17 +
      (calibration.anchorMode === "wrist" ? 0.18 : 0)) *
      100,
  );

  const updateCalibration = useCallback(
    (
      updater:
        | ProductFitConfig
        | ((current: ProductFitConfig) => ProductFitConfig),
    ) => {
      setProductConfigs((current) => {
        const currentConfig =
          current[selectedProductId] ?? selectedProduct.fit;
        const nextConfig =
          typeof updater === "function" ? updater(currentConfig) : updater;
        return nextConfig === currentConfig
          ? current
          : { ...current, [selectedProductId]: nextConfig };
      });
    },
    [selectedProduct.fit, selectedProductId],
  );

  const getDeviceKind = useCallback(
    () =>
      classifyDevice({
        viewportWidth: window.innerWidth,
        coarsePointer: window.matchMedia("(pointer: coarse)").matches,
        userAgent: navigator.userAgent,
      }),
    [],
  );

  const recordAnalytics = useCallback(
    (
      eventName: AnalyticsEventName,
      options: { productId?: string; errorKind?: string } = {},
    ) => {
      setAnalytics((current) =>
        recordTryOnEvent(current, eventName, {
          productId: options.productId ?? selectedProductRef.current.id,
          deviceKind: eventName === "page_view" ? getDeviceKind() : undefined,
          errorKind: options.errorKind,
        }),
      );
    },
    [getDeviceKind],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setProductConfigs(restoreProductConfigs());
      setAnalytics(restoreAnalyticsSnapshot());
      setLocalStateRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    selectedProductRef.current = selectedProduct;
    rendererRef.current?.setAppearance({
      ...selectedProduct,
      ...calibrationRef.current,
    });
  }, [selectedProduct]);

  useEffect(() => {
    calibrationRef.current = calibration;
    rendererRef.current?.setAppearance({
      ...selectedProduct,
      ...calibration,
    });
  }, [calibration, selectedProduct]);

  useEffect(() => {
    if (!localStateRestored) return;
    try {
      window.localStorage.setItem(
        fitConfigStorageKey,
        JSON.stringify(productConfigs),
      );
    } catch {
      // Storage can be disabled in private browsing; live calibration still works.
    }
  }, [localStateRestored, productConfigs]);

  useEffect(() => {
    if (!localStateRestored) return;
    try {
      window.localStorage.setItem(
        analyticsStorageKey,
        JSON.stringify(analytics),
      );
    } catch {
      // Analytics are a convenience layer; the try-on flow must still run.
    }
  }, [analytics, localStateRestored]);

  useEffect(() => {
    if (!localStateRestored || pageViewRecordedRef.current) return;
    pageViewRecordedRef.current = true;
    recordAnalytics("page_view");
  }, [localStateRestored, recordAnalytics]);

  useEffect(() => {
    calibrationOpenRef.current = calibrationOpen;
  }, [calibrationOpen]);

  const toggleCalibration = useCallback(() => {
    const nextOpen = !calibrationOpenRef.current;
    calibrationOpenRef.current = nextOpen;
    setCalibrationOpen(nextOpen);
    if (nextOpen) {
      setDebugPerformance(performanceSnapshotRef.current);
    } else {
      setDebugFrame(null);
      lastDebugUpdateRef.current = 0;
    }
  }, []);

  const resizeOverlay = useCallback(() => {
    const host = overlayHostRef.current;
    const renderer = rendererRef.current;
    if (!host || !renderer) return;
    renderer.resize(host.clientWidth || 1, host.clientHeight || 1);
  }, []);

  const resetPerformanceStats = useCallback(() => {
    const emptyStats = emptyPerformanceStats();
    performanceAccumulatorRef.current = createPerformanceAccumulator();
    performanceSnapshotRef.current = emptyStats;
    setDebugPerformance(emptyStats);
  }, []);

  const publishPerformanceStats = useCallback((timestamp: number) => {
    const accumulator = performanceAccumulatorRef.current;
    if (!accumulator.windowStartedAt) {
      accumulator.windowStartedAt = timestamp;
    }
    accumulator.renderLoopFrames += 1;

    const elapsed = timestamp - accumulator.windowStartedAt;
    if (elapsed < performanceUpdateIntervalMs) return;

    const nextStats: DebugPerformanceStats = {
      inferenceMs: averagePerformanceMetric(accumulator, "inferenceMs"),
      trackingFrameMs: averagePerformanceMetric(accumulator, "trackingFrameMs"),
      smoothingMs: averagePerformanceMetric(accumulator, "smoothingMs"),
      renderMs: averagePerformanceMetric(accumulator, "renderMs"),
      fps: (accumulator.renderLoopFrames * 1000) / Math.max(elapsed, 1),
    };
    performanceSnapshotRef.current = nextStats;
    performanceAccumulatorRef.current = createPerformanceAccumulator(timestamp);
    if (calibrationOpenRef.current) setDebugPerformance(nextStats);
  }, []);

  const updateTrackingState = useCallback((isTracking: boolean) => {
    if (trackingRef.current === isTracking) return;
    trackingRef.current = isTracking;
    if (isTracking && !trackedThisSessionRef.current) {
      trackedThisSessionRef.current = true;
      recordAnalytics("tracking_start");
    }
    setStatus(isTracking ? "tracking" : "ready");
  }, [recordAnalytics]);

  const updateDetectedHands = useCallback((count: number) => {
    const stableCount = handCountStabilizerRef.current.update(count);
    if (detectedHandsRef.current === stableCount) return;
    detectedHandsRef.current = stableCount;
    setDetectedHands(stableCount);
  }, []);

  const updateAutoFitStatus = useCallback((nextStatus: AutoFitStatus) => {
    if (autoFitStatusRef.current === nextStatus) return;
    autoFitStatusRef.current = nextStatus;
    setAutoFitStatus(nextStatus);
  }, []);

  const failTracking = useCallback(
    (
      message = "手部识别运行异常，请重新启动相机。",
      recoveryKind: ErrorRecoveryKind = "tracking-runtime",
    ) => {
      isActiveRef.current = false;
      trackingRef.current = false;
      workerBusyRef.current = false;
      trackedThisSessionRef.current = false;
      handCountStabilizerRef.current.reset();
      recordAnalytics("tracking_error", { errorKind: recoveryKind });
      updateDetectedHands(0);
      poseSmootherRef.current.reset();
      posePredictorRef.current.reset();
      scaleControllerRef.current.reset();
      updateAutoFitStatus("settling");
      physicsRef.current.reset();
      renderPoseRef.current = null;
      poseVisibleRef.current = false;
      lastVisiblePoseTimestampRef.current = 0;
      renderedPoseRef.current = false;
      setDebugFrame(null);
      resetPerformanceStats();
      rendererRef.current?.clear();
      if (renderAnimationFrameRef.current !== null) {
        cancelAnimationFrame(renderAnimationFrameRef.current);
        renderAnimationFrameRef.current = null;
      }
      if (detectionTimeoutRef.current !== null) {
        window.clearTimeout(detectionTimeoutRef.current);
        detectionTimeoutRef.current = null;
      }
      if (
        videoRef.current &&
        videoFrameCallbackRef.current !== null
      ) {
        videoRef.current.cancelVideoFrameCallback(videoFrameCallbackRef.current);
        videoFrameCallbackRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      if (motionHandlerRef.current) {
        window.removeEventListener("devicemotion", motionHandlerRef.current);
        motionHandlerRef.current = null;
      }
      setStatus("error");
      setErrorMessage(message);
      setErrorRecoveryKind(recoveryKind);
    },
    [
      recordAnalytics,
      resetPerformanceStats,
      updateAutoFitStatus,
      updateDetectedHands,
    ],
  );

  const processDetectionResult = useCallback(
    (result: HandLandmarkerResult, timestamp: number, videoTime: number) => {
      const video = videoRef.current;
      if (!video) return;

      lastVideoTimeRef.current = videoTime;
      const reliableHandCount = result.landmarks.filter(
        (landmarks) => landmarks.length >= 18,
      ).length;
      updateDetectedHands(reliableHandCount);

      const selectedIndex = selectPrimaryHand(
        result.landmarks,
        result.handedness,
        selectedHandRef.current,
      );
      const selectedLandmarks =
        selectedIndex >= 0 ? result.landmarks[selectedIndex] : undefined;
      const selectedWorldLandmarks =
        selectedIndex >= 0 ? result.worldLandmarks[selectedIndex] : undefined;
      const category = result.handedness[selectedIndex]?.[0]?.categoryName;
      const handedness: HandednessLabel =
        category === "Left" || category === "Right" ? category : "Unknown";
      const sourceAspect =
        (video.videoWidth || 4) / (video.videoHeight || 3);
      const rawPose = selectedLandmarks
        ? calculateWristPose(
            selectedLandmarks,
            selectedWorldLandmarks,
            handedness,
            {
              anchorOffset: calibrationRef.current.anchorOffset,
              anchorMode: calibrationRef.current.anchorMode,
              sourceAspect,
              wristToPalmRatio: calibrationRef.current.wristToPalmRatio,
            },
          )
        : null;
      const handScore = result.handedness[selectedIndex]?.[0]?.score ?? 1;
      const confidenceAdjustedPose = rawPose
        ? { ...rawPose, confidence: Math.min(rawPose.confidence, handScore) }
        : null;
      const host = overlayHostRef.current;
      const stageAspect =
        (host?.clientWidth || 4) / (host?.clientHeight || 3);
      const displayPose = mapPoseToStage(
        confidenceAdjustedPose && confidenceAdjustedPose.confidence >= 0.35
          ? confidenceAdjustedPose
          : null,
        sourceAspect,
        stageAspect,
      );
      const smoothingStartedAt = performance.now();
      const pose = displayPose
        ? poseSmootherRef.current.update(
            displayPose,
            timestamp,
            positionFilterEnabledRef.current,
          )
        : poseSmootherRef.current.hold(timestamp);
      recordPerformanceMetric(
        performanceAccumulatorRef.current,
        "smoothingMs",
        performance.now() - smoothingStartedAt,
      );
      // Let auto-fit respond to the newest width signal instead of the
      // smoother's older measurement.
      const fitPose =
        pose && displayPose
          ? {
              ...pose,
              palmLength: displayPose.palmLength,
              wristWidth: displayPose.wristWidth,
            }
          : pose;
      const fitResult = pose
        ? displayPose && fitPose
          ? scaleControllerRef.current.update(fitPose, timestamp)
          : scaleControllerRef.current.hold()
        : null;
      const renderPose =
        pose && calibrationRef.current.autoFitEnabled && fitResult?.wristWidth
          ? { ...pose, wristWidth: fitResult.wristWidth }
          : pose;
      renderPoseRef.current = renderPose;
      poseVisibleRef.current = Boolean(displayPose);
      if (displayPose && renderPose) {
        lastVisiblePoseTimestampRef.current = timestamp;
        posePredictorRef.current.update(renderPose, timestamp);
      }
      if (fitResult) updateAutoFitStatus(fitResult.status);

      if (
        calibrationOpenRef.current &&
        timestamp - lastDebugUpdateRef.current >= 100
      ) {
        setDebugFrame({
          landmarks: selectedLandmarks ?? [],
          pose: renderPose,
          orientationConfidence: renderPose
            ? calculateOrientationConfidence(renderPose)
            : null,
          sourceAspect,
          stageAspect,
        });
        lastDebugUpdateRef.current = timestamp;
      }

      if (displayPose) {
        selectedHandRef.current = displayPose.handedness;
      }
    },
    [updateAutoFitStatus, updateDetectedHands],
  );

  const renderLoop = useCallback(
    (timestamp: number) => {
      const renderer = rendererRef.current;
      if (!isActiveRef.current || !renderer) return;

      const heldPose = renderPoseRef.current
        ? poseSmootherRef.current.hold(timestamp)
        : null;
      const pose =
        heldPose && poseVisibleRef.current
          ? posePredictorRef.current.predict(timestamp) ?? heldPose
          : heldPose;
      if (!pose) {
        renderPoseRef.current = null;
        if (renderedPoseRef.current) {
          const renderStartedAt = performance.now();
          renderer.clear();
          recordPerformanceMetric(
            performanceAccumulatorRef.current,
            "renderMs",
            performance.now() - renderStartedAt,
          );
          renderedPoseRef.current = false;
        }
        updateTrackingState(false);
      } else {
        renderPoseRef.current = pose;
        const elapsedSeconds =
          lastFrameTimestampRef.current > 0
            ? (timestamp - lastFrameTimestampRef.current) / 1000
            : 1 / 60;
        lastFrameTimestampRef.current = timestamp;
        let physics = rigidBraceletPhysics;
        if (physicsEnabledRef.current) {
          const gravityTarget = projectGravityToWristPlane(
            pose,
            gravityRef.current,
          );
          physics = physicsRef.current.update(
            gravityTarget.targetRoll,
            gravityTarget.alongArm,
            elapsedSeconds,
          );
        }
        const opacity =
          Math.min(1, 0.72 + pose.confidence * 0.3) *
          (poseVisibleRef.current
            ? 1
            : Math.min(
                1,
                Math.max(
                  0,
                  1 -
                    Math.max(
                      0,
                      timestamp - lastVisiblePoseTimestampRef.current -
                        poseVisibilityGraceMs,
                    ) /
                      poseVisibilityFadeMs,
                ),
              ));
        const renderStartedAt = performance.now();
        renderer.render(pose, physics, opacity, timestamp);
        recordPerformanceMetric(
          performanceAccumulatorRef.current,
          "renderMs",
          performance.now() - renderStartedAt,
        );
        renderedPoseRef.current = true;
        updateTrackingState(true);
      }

      publishPerformanceStats(timestamp);

      renderAnimationFrameRef.current = requestAnimationFrame((nextTimestamp) => {
        renderLoopRef.current(nextTimestamp);
      });
    },
    [publishPerformanceStats, updateTrackingState],
  );

  const prepareMainThreadHandLandmarker = useCallback(async () => {
    if (handLandmarkerRef.current) return;

    const { FilesetResolver, HandLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    configureMediaPipeRuntimeLogging();
    const vision = await FilesetResolver.forVisionTasks(mediaPipeWasmPath);

    try {
      handLandmarkerRef.current = await HandLandmarker.createFromOptions(
        vision,
        {
          ...handLandmarkerOptions,
          baseOptions: {
            modelAssetPath: handLandmarkerModelAssetPath,
            delegate: "GPU",
          },
        },
      );
    } catch {
      try {
        handLandmarkerRef.current = await HandLandmarker.createFromOptions(
          vision,
          {
            ...handLandmarkerOptions,
            baseOptions: {
              modelAssetPath: handLandmarkerModelAssetPath,
              delegate: "CPU",
            },
          },
        );
      } catch {
        throw new Error(modelLoadErrorMessage);
      }
    }
  }, []);

  const scheduleDetection = useCallback((video: HTMLVideoElement) => {
    if (typeof video.requestVideoFrameCallback === "function") {
      if (videoFrameCallbackRef.current !== null) return;
      videoFrameCallbackRef.current = video.requestVideoFrameCallback(
        (_timestamp, metadata) => {
          videoFrameCallbackRef.current = null;
          detectionLoopRef.current(metadata);
        },
      );
      return;
    }

    if (detectionTimeoutRef.current !== null) return;
    detectionTimeoutRef.current = window.setTimeout(
      () => {
        detectionTimeoutRef.current = null;
        detectionLoopRef.current();
      },
      minimumInferenceIntervalMs,
    );
  }, []);

  const fallbackToMainThreadDetection = useCallback(
    async (worker: Worker) => {
      if (handTrackingWorkerRef.current === worker) {
        handTrackingWorkerRef.current = null;
      }
      worker.terminate();
      workerBusyRef.current = false;

      try {
        await prepareMainThreadHandLandmarker();
      } catch {
        failTracking(modelLoadErrorMessage, "model-loading");
        return;
      }

      if (!isActiveRef.current) return;

      setCaptureMessage("已切换兼容识别模式");
      window.setTimeout(() => setCaptureMessage(""), 2200);
      const video = videoRef.current;
      if (video) scheduleDetection(video);
    },
    [failTracking, prepareMainThreadHandLandmarker, scheduleDetection],
  );

  const detectionLoop = useCallback((metadata?: VideoFrameCallbackMetadata) => {
    const video = videoRef.current;
    const worker = handTrackingWorkerRef.current;
    const landmarker = handLandmarkerRef.current;

    if (!isActiveRef.current || !video || (!worker && !landmarker)) return;

    if (worker && workerBusyRef.current) return;

    if (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      lastVideoTimeRef.current !== (metadata?.mediaTime ?? video.currentTime)
    ) {
      if (worker) {
        if (!workerBusyRef.current) {
          const videoTime = metadata?.mediaTime ?? video.currentTime;
          const timestamp = performance.now();
          workerBusyRef.current = true;
          lastVideoTimeRef.current = videoTime;
          createImageBitmap(video, {
            resizeWidth: inferenceFrameWidth,
            resizeHeight: inferenceFrameHeight,
            resizeQuality: "low",
          })
            .then((frame) => {
              if (
                !isActiveRef.current ||
                handTrackingWorkerRef.current !== worker
              ) {
                frame.close();
                workerBusyRef.current = false;
                return;
              }
              try {
                worker.postMessage(
                  {
                    type: "detect",
                    frame,
                    sessionId: trackingSessionRef.current,
                    timestamp,
                    videoTime,
                  },
                  [frame],
                );
              } catch {
                frame.close();
                workerBusyRef.current = false;
                void fallbackToMainThreadDetection(worker);
              }
            })
            .catch(() => {
              workerBusyRef.current = false;
              void fallbackToMainThreadDetection(worker);
            });
          return;
        }
      } else if (landmarker) {
        const trackingStartedAt = performance.now();
        try {
          const inferenceStartedAt = performance.now();
          const result = landmarker.detectForVideo(video, trackingStartedAt);
          recordPerformanceMetric(
            performanceAccumulatorRef.current,
            "inferenceMs",
            performance.now() - inferenceStartedAt,
          );
          processDetectionResult(result, trackingStartedAt, video.currentTime);
          recordPerformanceMetric(
            performanceAccumulatorRef.current,
            "trackingFrameMs",
            performance.now() - trackingStartedAt,
          );
        } catch {
          failTracking();
          return;
        }
      }
    }

    scheduleDetection(video);
  }, [
    failTracking,
    fallbackToMainThreadDetection,
    processDetectionResult,
    scheduleDetection,
  ]);

  useEffect(() => {
    renderLoopRef.current = renderLoop;
  }, [renderLoop]);

  useEffect(() => {
    detectionLoopRef.current = detectionLoop;
  }, [detectionLoop]);

  useEffect(() => {
    const host = overlayHostRef.current;
    if (!host) return;

    rendererRef.current = new ThreeTryOnRenderer(host, selectedProductRef.current);
    const resizeObserver = new ResizeObserver(resizeOverlay);
    resizeObserver.observe(host);
    resizeOverlay();

    return () => {
      resizeObserver.disconnect();
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [resizeOverlay]);

  const prepareHandLandmarker = useCallback(async () => {
    if (handTrackingWorkerRef.current || handLandmarkerRef.current) return;

    if (
      typeof Worker !== "undefined" &&
      typeof createImageBitmap === "function"
    ) {
      let worker: Worker | null = null;
      try {
        worker = new Worker(
          new URL("../workers/hand-landmarker.worker.ts", import.meta.url),
          { type: "module" },
        );

        let initializationPending = true;
        let resolveReady: () => void = () => undefined;
        let rejectReady: (error: Error) => void = () => undefined;
        const readyPromise = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const readyTimeout = window.setTimeout(() => {
          if (!initializationPending) return;
          initializationPending = false;
          rejectReady(new Error("手部模型加载超时"));
        }, 10000);

        worker.onmessage = (event: MessageEvent<HandTrackingWorkerResponse>) => {
          const message = event.data;
          if (message.type === "ready") {
            initializationPending = false;
            window.clearTimeout(readyTimeout);
            resolveReady();
            return;
          }

          if (message.type === "result") {
            if (message.sessionId !== trackingSessionRef.current) return;
            workerBusyRef.current = false;
            if (isActiveRef.current) {
              recordPerformanceMetric(
                performanceAccumulatorRef.current,
                "inferenceMs",
                message.inferenceMs,
              );
              processDetectionResult(
                message.result,
                message.timestamp,
                message.videoTime,
              );
              recordPerformanceMetric(
                performanceAccumulatorRef.current,
                "trackingFrameMs",
                performance.now() - message.timestamp,
              );
              const video = videoRef.current;
              if (video) detectionLoopRef.current();
            }
            return;
          }

          if (
            message.sessionId !== undefined &&
            message.sessionId !== trackingSessionRef.current
          ) {
            return;
          }
          workerBusyRef.current = false;
          if (initializationPending) {
            initializationPending = false;
            window.clearTimeout(readyTimeout);
            rejectReady(new Error(message.message));
            return;
          }

          worker?.terminate();
          handTrackingWorkerRef.current = null;
          const messageText = message.message || "手部识别运行异常，请重试。";
          failTracking(messageText, recoveryKindFromMessage(messageText));
        };
        worker.onerror = () => {
          workerBusyRef.current = false;
          if (initializationPending) {
            initializationPending = false;
            window.clearTimeout(readyTimeout);
            rejectReady(new Error("手部模型加载失败"));
            return;
          }

          worker?.terminate();
          handTrackingWorkerRef.current = null;
          failTracking("手部识别运行异常，请重试。", "tracking-runtime");
        };
        worker.postMessage({
          type: "initialize",
          modelAssetPath: handLandmarkerModelAssetPath,
          wasmPath: mediaPipeWasmPath,
        });
        await readyPromise;
        handTrackingWorkerRef.current = worker;
        return;
      } catch {
        worker?.terminate();
        workerBusyRef.current = false;
      }
    }

    await prepareMainThreadHandLandmarker();
  }, [failTracking, prepareMainThreadHandLandmarker, processDetectionResult]);

  const enableDeviceMotion = useCallback(async () => {
    if (motionHandlerRef.current) return;

    const MotionEvent = window.DeviceMotionEvent as
      | (typeof DeviceMotionEvent & {
          requestPermission?: () => Promise<"granted" | "denied">;
        })
      | undefined;
    if (typeof MotionEvent?.requestPermission === "function") {
      try {
        const permission = await MotionEvent.requestPermission();
        if (permission !== "granted") return;
      } catch {
        return;
      }
    }

    const handler = (event: DeviceMotionEvent) => {
      const acceleration = event.accelerationIncludingGravity;
      if (
        acceleration?.x === null ||
        acceleration?.y === null ||
        acceleration?.z === null
      ) {
        return;
      }
      const vector = {
        x: acceleration?.x ?? 0,
        y: acceleration?.y ?? 0,
        z: acceleration?.z ?? 0,
      };
      const length = Math.hypot(vector.x, vector.y, vector.z);
      if (length < 0.001) return;
      gravityRef.current = {
        x: vector.x / length,
        y: vector.y / length,
        z: vector.z / length,
      };
    };

    motionHandlerRef.current = handler;
    window.addEventListener("devicemotion", handler, { passive: true });
  }, []);

  const startCamera = useCallback(async () => {
    if (status === "loading") return;

    recordAnalytics("camera_request");
    resetPerformanceStats();
    setErrorMessage("");
    setErrorRecoveryKind("tracking-runtime");
    setCaptureMessage("");
    setStatus("loading");

    let stream: MediaStream | null = null;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前浏览器不支持摄像头");
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 640, max: 960 },
          height: { ideal: 480, max: 720 },
        },
      });

      await prepareHandLandmarker();
      await enableDeviceMotion();

      const video = videoRef.current;
      if (!video) throw new Error("摄像头画面初始化失败");

      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      resizeOverlay();
      lastVideoTimeRef.current = -1;
      lastFrameTimestampRef.current = 0;
      renderPoseRef.current = null;
      poseVisibleRef.current = false;
      lastVisiblePoseTimestampRef.current = 0;
      renderedPoseRef.current = false;
      trackedThisSessionRef.current = false;
      posePredictorRef.current.reset();
      workerBusyRef.current = false;
      trackingSessionRef.current += 1;
      isActiveRef.current = true;
      trackingRef.current = false;
      detectedHandsRef.current = 0;
      handCountStabilizerRef.current.reset();
      selectedHandRef.current = "Unknown";
      gravityRef.current = defaultGravity;
      poseSmootherRef.current.reset();
      scaleControllerRef.current.reset();
      updateAutoFitStatus("settling");
      physicsRef.current.reset();
      setDetectedHands(0);
      setStatus("ready");
      recordAnalytics("camera_grant");
      renderAnimationFrameRef.current = requestAnimationFrame((timestamp) => {
        renderLoopRef.current(timestamp);
      });
      detectionLoopRef.current();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (motionHandlerRef.current) {
        window.removeEventListener("devicemotion", motionHandlerRef.current);
        motionHandlerRef.current = null;
      }
      setStatus("error");
      const startupError = resolveStartupError(error);
      recordAnalytics("camera_error", { errorKind: startupError.recoveryKind });
      setErrorMessage(startupError.message);
      setErrorRecoveryKind(startupError.recoveryKind);
    }
  }, [
    enableDeviceMotion,
    prepareHandLandmarker,
    recordAnalytics,
    resetPerformanceStats,
    resizeOverlay,
    status,
    updateAutoFitStatus,
  ]);

  const stopCamera = useCallback(() => {
    isActiveRef.current = false;
    trackingRef.current = false;
    detectedHandsRef.current = 0;
    handCountStabilizerRef.current.reset();
    selectedHandRef.current = "Unknown";
    lastVideoTimeRef.current = -1;
    lastFrameTimestampRef.current = 0;
    renderPoseRef.current = null;
    poseVisibleRef.current = false;
    lastVisiblePoseTimestampRef.current = 0;
    renderedPoseRef.current = false;
    trackedThisSessionRef.current = false;
    posePredictorRef.current.reset();
    workerBusyRef.current = false;
    trackingSessionRef.current += 1;
    poseSmootherRef.current.reset();
    scaleControllerRef.current.reset();
    updateAutoFitStatus("settling");
    physicsRef.current.reset();
    setDebugFrame(null);
    resetPerformanceStats();
    rendererRef.current?.clear();
    setDetectedHands(0);
    if (renderAnimationFrameRef.current !== null) {
      cancelAnimationFrame(renderAnimationFrameRef.current);
      renderAnimationFrameRef.current = null;
    }
    if (detectionTimeoutRef.current !== null) {
      window.clearTimeout(detectionTimeoutRef.current);
      detectionTimeoutRef.current = null;
    }
    if (
      videoRef.current &&
      videoFrameCallbackRef.current !== null
    ) {
      videoRef.current.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (motionHandlerRef.current) {
      window.removeEventListener("devicemotion", motionHandlerRef.current);
      motionHandlerRef.current = null;
    }
    setErrorMessage("");
    setErrorRecoveryKind("tracking-runtime");
    setStatus("idle");
  }, [resetPerformanceStats, updateAutoFitStatus]);

  useEffect(() => {
    const handleResize = () => resizeOverlay();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      stopCamera();
      handLandmarkerRef.current?.close?.();
      handTrackingWorkerRef.current?.terminate();
      handTrackingWorkerRef.current = null;
    };
  }, [resizeOverlay, stopCamera]);

  const captureTryOn = useCallback(() => {
    const video = videoRef.current;
    const overlay = rendererRef.current?.getCanvas();
    const stage = overlayHostRef.current;
    if (
      !video ||
      !overlay ||
      !stage ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      setCaptureMessage("请先启动相机");
      return;
    }

    const sourceAspect =
      (video.videoWidth || 4) / (video.videoHeight || 3);
    const stageAspect = (stage.clientWidth || 4) / (stage.clientHeight || 3);
    const outputWidth = video.videoWidth || 960;
    const outputHeight = Math.round(outputWidth / stageAspect);
    const output = document.createElement("canvas");
    output.width = outputWidth;
    output.height = outputHeight;
    const context = output.getContext("2d");
    if (!context) return;

    context.save();
    context.translate(output.width, 0);
    context.scale(-1, 1);

    if (sourceAspect > stageAspect) {
      const cropWidth = video.videoHeight * stageAspect;
      const cropX = (video.videoWidth - cropWidth) / 2;
      context.drawImage(
        video,
        cropX,
        0,
        cropWidth,
        video.videoHeight,
        0,
        0,
        output.width,
        output.height,
      );
    } else {
      const cropHeight = video.videoWidth / stageAspect;
      const cropY = (video.videoHeight - cropHeight) / 2;
      context.drawImage(
        video,
        0,
        cropY,
        video.videoWidth,
        cropHeight,
        0,
        0,
        output.width,
        output.height,
      );
    }
    context.drawImage(overlay, 0, 0, output.width, output.height);
    context.restore();

    output.toBlob((blob) => {
      if (!blob) {
        setCaptureMessage("截图失败，请重试");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ar-jewelry-${selectedProduct.id}.png`;
      link.click();
      URL.revokeObjectURL(url);
      recordAnalytics("screenshot");
      setCaptureMessage("截图已下载");
      window.setTimeout(() => setCaptureMessage(""), 2400);
    }, "image/png");
  }, [recordAnalytics, selectedProduct.id]);

  const shareTryOn = useCallback(async () => {
    const shareData = {
      title: `AR 首饰试戴 · ${selectedProduct.name}`,
      text: `试戴 ${selectedProduct.name} ${selectedProduct.material}`,
      url: window.location.href,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        recordAnalytics("share");
        return;
      }
      await navigator.clipboard.writeText(window.location.href);
      recordAnalytics("share");
      setCaptureMessage("试戴链接已复制");
      window.setTimeout(() => setCaptureMessage(""), 2400);
    } catch {
      setCaptureMessage("分享已取消");
      window.setTimeout(() => setCaptureMessage(""), 1800);
    }
  }, [recordAnalytics, selectedProduct]);

  const resetAnalytics = useCallback(() => {
    setAnalytics(createTryOnAnalytics());
    pageViewRecordedRef.current = false;
  }, []);

  const statusClass = status === "tracking" ? "is-live" : `is-${status}`;
  const selectedAnalytics = summarizeProductAnalytics(
    analytics,
    selectedProduct.id,
  );
  const cameraAuthorizationRate = calculateRate(
    analytics.totals.camera_grant,
    analytics.totals.camera_request,
  );
  const tryOnToPurchaseRate = calculateRate(
    analytics.totals.purchase_click,
    analytics.totals.tracking_start,
  );
  const cameraPrompt =
    status === "loading"
      ? "正在连接摄像头"
      : status === "ready"
        ? "请将整只手和手腕放入取景框"
        : status === "error"
          ? errorMessage
          : "启动相机后开始识别";
  const errorRecovery = errorRecoveryCopy[errorRecoveryKind];
  const debugLandmarks = debugFrame?.landmarks ?? null;
  const debugPose = debugFrame?.pose ?? null;
  const debugSourceAspect = debugFrame?.sourceAspect ?? 4 / 3;
  const debugStageAspect = debugFrame?.stageAspect ?? 4 / 3;
  const debugMappedPoints = debugLandmarks
    ? [0, 5, 9, 13, 17].flatMap((index) => {
        const landmark = debugLandmarks[index];
        return landmark
          ? [{ index, point: mapPointToStage(landmark, debugSourceAspect, debugStageAspect) }]
          : [];
      })
    : [];
  const debugWristPoint = debugLandmarks?.[0]
    ? mapPointToStage(debugLandmarks[0], debugSourceAspect, debugStageAspect)
    : null;
  const debugPalmCenter =
    debugLandmarks?.[5] &&
    debugLandmarks[9] &&
    debugLandmarks[13] &&
    debugLandmarks[17]
      ? mapPointToStage(
          {
            x:
              ((debugLandmarks[5].x + debugLandmarks[17].x) / 2) * 0.72 +
              ((debugLandmarks[9].x + debugLandmarks[13].x) / 2) * 0.28,
            y:
              ((debugLandmarks[5].y + debugLandmarks[17].y) / 2) * 0.72 +
              ((debugLandmarks[9].y + debugLandmarks[13].y) / 2) * 0.28,
          },
          debugSourceAspect,
          debugStageAspect,
        )
      : null;
  const debugArmAngle =
    debugWristPoint && debugPalmCenter
      ? (Math.atan2(
          debugPalmCenter.y - debugWristPoint.y,
          debugPalmCenter.x - debugWristPoint.x,
        ) *
          180) /
        Math.PI
      : 0;
  const debugArmLength =
    debugWristPoint && debugPalmCenter
      ? Math.max(
          2,
          Math.hypot(
            debugPalmCenter.x - debugWristPoint.x,
            debugPalmCenter.y - debugWristPoint.y,
          ) * 100,
        )
      : 0;

  return (
    <main className="tryon-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Sparkles size={18} strokeWidth={1.7} />
          </div>
          <div>
            <p className="eyebrow">AR JEWELRY / 01</p>
            <h1>腕间试戴</h1>
          </div>
        </div>

        <div className={`status-chip ${statusClass}`}>
          <span className="status-dot" aria-hidden="true" />
          <span>{statusLabels[status]}</span>
        </div>
      </header>

      <section className="workspace">
        <div className="camera-column">
          <div className="section-heading">
            <div>
              <p className="eyebrow">LIVE FITTING / 3D DEPTH</p>
              <h2>把整只手和手腕放入画面</h2>
            </div>
            <span className="camera-meta">HAND / WRIST</span>
          </div>

          <div
            className={`camera-stage ${status === "tracking" ? "is-tracking" : ""}`}
          >
            <video
              ref={videoRef}
              className="camera-video"
              autoPlay
              muted
              playsInline
              aria-label="摄像头试戴画面"
            />
            <div ref={overlayHostRef} className="tryon-overlay-host" />

            {status !== "tracking" && (
              <div className="camera-frame" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
            )}

            {status !== "tracking" && (
              <div
                className={`camera-placeholder ${
                  status === "ready" ? "is-guidance" : ""
                }`}
              >
                <div className="placeholder-icon">
                  {status === "error" ? (
                    <RotateCcw size={22} />
                  ) : (
                    <Hand size={22} />
                  )}
                </div>
                <p>{cameraPrompt}</p>
                {status === "error" && (
                  <div className="camera-error-actions">
                    <small>{errorRecovery.hint}</small>
                    <button
                      className="camera-retry-button"
                      type="button"
                      onClick={startCamera}
                    >
                      <RotateCcw size={15} />
                      <span>{errorRecovery.actionLabel}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {calibrationOpen && debugLandmarks && (
              <div className="calibration-markers" aria-hidden="true">
                {debugMappedPoints.map(({ index, point }) => (
                  <span
                    className={`calibration-marker calibration-marker-${index}`}
                    key={index}
                    style={{
                      left: `${point.x * 100}%`,
                      top: `${point.y * 100}%`,
                    }}
                  />
                ))}
                {debugPose && (
                  <span
                    className="calibration-anchor-marker"
                    style={{
                      left: `${debugPose.x * 100}%`,
                      top: `${debugPose.y * 100}%`,
                    }}
                  />
                )}
                {debugWristPoint && debugArmLength > 0 && (
                  <span
                    className="calibration-arm-line"
                    style={{
                      left: `${debugWristPoint.x * 100}%`,
                      top: `${debugWristPoint.y * 100}%`,
                      width: `${debugArmLength}%`,
                      transform: `translateY(-50%) rotate(${debugArmAngle}deg)`,
                    }}
                  />
                )}
              </div>
            )}

            <div className="stage-footer">
              <span>WEBGL / OCCLUSION</span>
              <span>{`HANDS: ${detectedHands}`}</span>
            </div>
          </div>

          <div className="camera-actions">
            <button
              className="button button-primary"
              type="button"
              onClick={
                status === "idle" || status === "error" ? startCamera : stopCamera
              }
              disabled={status === "loading"}
            >
              {status === "idle" || status === "error" ? (
                <Camera size={17} />
              ) : (
                <RotateCcw size={17} />
              )}
              <span>
                {status === "loading"
                  ? "准备中"
                  : status === "idle" || status === "error"
                    ? "启动相机"
                    : "结束试戴"}
              </span>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={captureTryOn}
              title="下载试戴截图"
              aria-label="下载试戴截图"
            >
              <Download size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={shareTryOn}
              title="分享试戴链接"
              aria-label="分享试戴链接"
            >
              <ExternalLink size={18} />
            </button>
            <button
              className={`icon-button calibration-toggle ${
                calibrationOpen ? "is-active" : ""
              }`}
              type="button"
              onClick={toggleCalibration}
              title={calibrationOpen ? "关闭校准模式" : "打开校准模式"}
              aria-label={calibrationOpen ? "关闭校准模式" : "打开校准模式"}
              aria-pressed={calibrationOpen}
            >
              <SlidersHorizontal size={18} />
            </button>
            {captureMessage && (
              <span className="action-message">{captureMessage}</span>
            )}
          </div>

          {calibrationOpen && (
            <section className="calibration-panel" aria-label="手链校准">
              <div className="calibration-heading">
                <div>
                  <p className="eyebrow">CALIBRATION / LIVE</p>
                  <h3>校准手链</h3>
                </div>
                <button
                  className="calibration-reset"
                  type="button"
                  onClick={() =>
                    updateCalibration({ ...selectedProduct.fit })
                  }
                  title="恢复当前款式默认值"
                  aria-label="恢复当前款式默认值"
                >
                  <RotateCcw size={16} />
                </button>
              </div>

              <label className="calibration-mode">
                <span>
                  <span>重力物理（调试）</span>
                  <small>
                    {physicsEnabled ? "ON · 重力滑动" : "OFF · 刚性跟随"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={physicsEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    physicsEnabledRef.current = enabled;
                    physicsRef.current.reset();
                    setPhysicsEnabled(enabled);
                  }}
                />
              </label>

              <label className="calibration-mode">
                <span>
                  <span>位置滤波（调试）</span>
                  <small>
                    {positionFilterEnabled
                      ? "ON · One Euro 5.2 / 2.8"
                      : "OFF · RAW X / Y"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={positionFilterEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    positionFilterEnabledRef.current = enabled;
                    poseSmootherRef.current.reset();
                    posePredictorRef.current.reset();
                    setPositionFilterEnabled(enabled);
                  }}
                />
              </label>

              <label className="calibration-mode">
                <span>
                  <span>Rotation Smoothing</span>
                  <small>
                    {calibration.rotationSmoothingEnabled
                      ? "ON · QUATERNION SLERP"
                      : "OFF · RAW ORIENTATION"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={calibration.rotationSmoothingEnabled}
                  onChange={(event) =>
                    updateCalibration((current) => ({
                      ...current,
                      rotationSmoothingEnabled: event.target.checked,
                    }))
                  }
                />
              </label>

              <div className="calibration-control calibration-anchor-mode">
                <div className="calibration-control-heading">
                  <span>定位方式</span>
                  <small>
                    {calibration.anchorMode === "wrist"
                      ? "腕点向小臂偏移"
                      : "沿掌根方向偏移"}
                  </small>
                </div>
                <div
                  className="segmented-control"
                  role="group"
                  aria-label="手链定位方式"
                >
                  <button
                    className={
                      calibration.anchorMode === "wrist" ? "is-selected" : ""
                    }
                    type="button"
                    aria-pressed={calibration.anchorMode === "wrist"}
                    onClick={() => {
                      updateCalibration((current) => ({
                        ...current,
                        anchorMode: "wrist",
                      }));
                      poseSmootherRef.current.reset();
                      physicsRef.current.reset();
                    }}
                  >
                    手腕锚定
                  </button>
                  <button
                    className={
                      calibration.anchorMode === "palm-root"
                        ? "is-selected"
                        : ""
                    }
                    type="button"
                    aria-pressed={calibration.anchorMode === "palm-root"}
                    onClick={() => {
                      updateCalibration((current) => ({
                        ...current,
                        anchorMode: "palm-root",
                      }));
                      poseSmootherRef.current.reset();
                      physicsRef.current.reset();
                    }}
                  >
                    掌根偏移
                  </button>
                </div>
              </div>

              <label className="calibration-mode">
                <span>
                  <span>自动匹配尺寸</span>
                  <small>
                    {calibration.autoFitEnabled ? "跟随远近" : "手动覆盖"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={calibration.autoFitEnabled}
                  onChange={(event) =>
                    updateCalibration((current) => ({
                      ...current,
                      autoFitEnabled: event.target.checked,
                    }))
                  }
                />
              </label>

              <label className="calibration-control">
                <span>
                  <span>Bracelet Fit Ratio</span>
                  <output>{calibration.braceletFitRatio.toFixed(2)}</output>
                </span>
                <input
                  type="range"
                  min="1"
                  max="1.15"
                  step="0.01"
                  value={calibration.braceletFitRatio}
                  onChange={(event) =>
                    updateCalibration((current) => ({
                      ...current,
                      braceletFitRatio: Number(event.target.value),
                    }))
                  }
                />
              </label>

              <label className="calibration-control">
                <span>
                  <span>Bracelet Aspect Ratio</span>
                  <output>{calibration.braceletAspectRatio.toFixed(2)}</output>
                </span>
                <input
                  type="range"
                  min="0.6"
                  max="1"
                  step="0.01"
                  value={calibration.braceletAspectRatio}
                  onChange={(event) =>
                    updateCalibration((current) => ({
                      ...current,
                      braceletAspectRatio: Number(event.target.value),
                    }))
                  }
                />
              </label>

              <label className="calibration-control">
                <span>
                  <span>Wrist Proxy Width</span>
                  <output>{calibration.wristProxyWidthRatio.toFixed(2)}</output>
                </span>
                <input
                  type="range"
                  min="0.75"
                  max="0.95"
                  step="0.01"
                  value={calibration.wristProxyWidthRatio}
                  onChange={(event) =>
                    updateCalibration((current) => ({
                      ...current,
                      wristProxyWidthRatio: Number(event.target.value),
                    }))
                  }
                />
              </label>

              {!calibration.autoFitEnabled && (
                <label className="calibration-control">
                  <span>
                    <span>手动尺寸</span>
                    <output>{Math.round(calibration.manualScale * 100)}%</output>
                  </span>
                  <input
                    type="range"
                    min={calibration.minimumScale}
                    max={calibration.maximumScale}
                    step="0.01"
                    value={calibration.manualScale}
                    onChange={(event) =>
                      updateCalibration((current) => ({
                        ...current,
                        manualScale: Number(event.target.value),
                      }))
                    }
                  />
                </label>
              )}

              <label className="calibration-control">
                <span>
                  <span>
                    {calibration.anchorMode === "wrist"
                      ? "手腕前后修正"
                      : "掌根前后位置"}
                  </span>
                  <output>
                    {calibration.anchorMode === "wrist"
                      ? `${anchorCorrectionPercent >= 0 ? "+" : ""}${anchorCorrectionPercent}%`
                      : `${Math.round(calibration.anchorOffset * 100)}%`}
                  </output>
                </span>
                <input
                  type="range"
                  min="0.04"
                  max="0.3"
                  step="0.01"
                  value={calibration.anchorOffset}
                  onChange={(event) =>
                    updateCalibration((current) => ({
                      ...current,
                      anchorOffset: Number(event.target.value),
                    }))
                  }
                />
              </label>

              <details className="calibration-advanced">
                <summary>高级尺寸参数</summary>
                <label className="calibration-control">
                  <span>
                    <span>腕宽 / 掌长比例</span>
                    <output>{calibration.wristToPalmRatio.toFixed(2)}</output>
                  </span>
                  <input
                    type="range"
                    min="0.5"
                    max="1"
                    step="0.01"
                    value={calibration.wristToPalmRatio}
                    onChange={(event) =>
                      updateCalibration((current) => ({
                        ...current,
                        wristToPalmRatio: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label className="calibration-control">
                  <span>
                    <span>最小渲染尺寸</span>
                    <output>{Math.round(calibration.minimumScale * 100)}%</output>
                  </span>
                  <input
                    type="range"
                    min="0.04"
                    max={Math.max(0.05, calibration.maximumScale - 0.01)}
                    step="0.01"
                    value={calibration.minimumScale}
                    onChange={(event) =>
                      updateCalibration((current) => {
                        const minimumScale = Math.min(
                          Number(event.target.value),
                          current.maximumScale - 0.01,
                        );
                        return {
                          ...current,
                          minimumScale,
                          manualScale: Math.max(current.manualScale, minimumScale),
                        };
                      })
                    }
                  />
                </label>
                <label className="calibration-control">
                  <span>
                    <span>最大渲染尺寸</span>
                    <output>{Math.round(calibration.maximumScale * 100)}%</output>
                  </span>
                  <input
                    type="range"
                    min={Math.min(1.2, calibration.minimumScale + 0.01)}
                    max="1.2"
                    step="0.01"
                    value={calibration.maximumScale}
                    onChange={(event) =>
                      updateCalibration((current) => {
                        const maximumScale = Math.max(
                          Number(event.target.value),
                          current.minimumScale + 0.01,
                        );
                        return {
                          ...current,
                          maximumScale,
                          manualScale: Math.min(current.manualScale, maximumScale),
                        };
                      })
                    }
                  />
                </label>
              </details>

              <div className="calibration-stats">
                <span>
                  腕宽估算
                  <strong>
                    {debugPose ? `${Math.round(debugPose.wristWidth * 100)}%` : "--"}
                  </strong>
                </span>
                <span>
                  自动尺寸
                  <strong>{autoFitStatusLabels[autoFitStatus]}</strong>
                </span>
                <span>
                  Orientation Confidence
                  <strong>
                    {debugFrame?.orientationConfidence === null ||
                    debugFrame?.orientationConfidence === undefined
                      ? "--"
                      : `${Math.round(debugFrame.orientationConfidence * 100)}%`}
                  </strong>
                </span>
              </div>
              <div
                className="calibration-stats"
                aria-label="性能统计，每秒平均值"
              >
                <span>
                  推理耗时
                  <strong>{formatTiming(debugPerformance.inferenceMs)}</strong>
                </span>
                <span>
                  跟踪帧耗时
                  <strong>{formatTiming(debugPerformance.trackingFrameMs)}</strong>
                </span>
                <span>
                  滤波耗时
                  <strong>
                    {formatTiming(debugPerformance.smoothingMs, 2)}
                  </strong>
                </span>
                <span>
                  Three 渲染
                  <strong>{formatTiming(debugPerformance.renderMs, 2)}</strong>
                </span>
                <span>
                  估算 FPS
                  <strong>{formatFps(debugPerformance.fps)}</strong>
                </span>
              </div>
            </section>
          )}
        </div>

        <aside className="control-column">
          <div className="control-section">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">SELECT PIECE</p>
                <h2>选择款式</h2>
              </div>
              <span className="count-label">{products.length} ITEMS</span>
            </div>

            <div className="product-list">
              {products.map((product) => {
                const isSelected = product.id === selectedProductId;
                return (
                  <button
                    className={`product-row ${isSelected ? "is-selected" : ""}`}
                    type="button"
                    key={product.id}
                    onClick={() => {
                      setSelectedProductId(product.id);
                      scaleControllerRef.current.reset();
                      updateAutoFitStatus("settling");
                      recordAnalytics("product_select", {
                        productId: product.id,
                      });
                    }}
                  >
                    <span
                      className="product-swatch"
                      style={{
                        backgroundColor: product.tint,
                        boxShadow: `inset 0 0 0 1px ${product.tint}66`,
                      }}
                    />
                    <span className="product-copy">
                      <strong>{product.name}</strong>
                      <small>
                        {product.material} · {product.color}
                      </small>
                    </span>
                    <span className="product-check">
                      {isSelected && <Check size={15} strokeWidth={2.4} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="control-section selected-section">
            <div className="selected-line">
              <span className="eyebrow">CURRENT PIECE</span>
              <span className="selected-id">
                #{selectedProduct.id.slice(0, 5).toUpperCase()}
              </span>
            </div>
            <h3>{selectedProduct.name}</h3>
            <p>
              {selectedProduct.material} · {selectedProduct.color}
            </p>

            <div className="trust-line">
              <ShieldCheck size={15} />
              <span>摄像头画面仅在本机处理</span>
            </div>

            <a
              className="button button-secondary"
              href={selectedProduct.buyUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                recordAnalytics("purchase_click", {
                  productId: selectedProduct.id,
                })
              }
            >
              <span>查看购买页</span>
              <ExternalLink size={16} />
            </a>
          </div>

          <div className="control-section analytics-section">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">LOCAL EVENTS</p>
                <h2>本机统计</h2>
              </div>
              <button
                className="analytics-reset"
                type="button"
                onClick={resetAnalytics}
                title="清空本机统计"
                aria-label="清空本机统计"
              >
                <RotateCcw size={15} />
              </button>
            </div>

            <div className="analytics-grid">
              <span>
                本款试戴
                <strong>{selectedAnalytics.tracking_start}</strong>
              </span>
              <span>
                本款截图
                <strong>{selectedAnalytics.screenshot}</strong>
              </span>
              <span>
                购买点击
                <strong>{selectedAnalytics.purchase_click}</strong>
              </span>
              <span>
                授权率
                <strong>{formatRate(cameraAuthorizationRate)}</strong>
              </span>
            </div>

            <div className="analytics-funnel">
              <div>
                <ChartNoAxesColumn size={15} />
                <span>总试戴 {analytics.totals.tracking_start}</span>
              </div>
              <div>
                <ExternalLink size={15} />
                <span>购买转化 {formatRate(tryOnToPurchaseRate)}</span>
              </div>
            </div>

            <p className="analytics-note">
              仅保存本机事件计数，不保存摄像头画面、截图或用户标识。
            </p>
          </div>
        </aside>
      </section>

      <footer className="bottom-bar">
        <span>TRY-ON LAB</span>
        <span>PROTO / 2026</span>
        <span>6DOF BRACELET</span>
      </footer>
    </main>
  );
}
