"use client";

import {
  Camera,
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
  WristScaleController,
  BraceletPhysics,
  calculateWristPose,
  projectGravityToWristPlane,
  selectPrimaryHand,
  WristPoseSmoother,
  type HandednessLabel,
  type HandLandmark,
  type Vector3,
  type WristPose,
} from "@/lib/tryon-core";
import { configureMediaPipeRuntimeLogging } from "@/lib/mediapipe-runtime";
import { ThreeTryOnRenderer } from "@/lib/three-tryon-renderer";

type CameraStatus = "idle" | "loading" | "ready" | "tracking" | "error";

type Calibration = {
  widthRatio: number;
  anchorOffset: number;
};

type DebugFrame = {
  landmarks: HandLandmark[];
  pose: WristPose | null;
  sourceAspect: number;
  stageAspect: number;
};

type Product = {
  id: string;
  name: string;
  material: string;
  color: string;
  accent: string;
  tint: string;
  widthRatio: number;
  buyUrl: string;
};

const products: Product[] = [
  {
    id: "aurora-gold",
    name: "Aurora",
    material: "18K 黄金",
    color: "金色",
    accent: "#e8f4f4",
    tint: "#d9a441",
    widthRatio: 1.04,
    buyUrl: "https://example.com/products/aurora",
  },
  {
    id: "mist-silver",
    name: "Mist",
    material: "925 银",
    color: "银色",
    accent: "#e5f1f4",
    tint: "#d8e0e5",
    widthRatio: 1.02,
    buyUrl: "https://example.com/products/mist",
  },
  {
    id: "rose-line",
    name: "Rose Line",
    material: "玫瑰金",
    color: "玫瑰金",
    accent: "#f2dfd9",
    tint: "#d6957e",
    widthRatio: 1.04,
    buyUrl: "https://example.com/products/rose-line",
  },
  {
    id: "onyx-link",
    name: "Onyx Link",
    material: "黑金",
    color: "黑色",
    accent: "#a6bac7",
    tint: "#4a5059",
    widthRatio: 1.06,
    buyUrl: "https://example.com/products/onyx-link",
  },
  {
    id: "pearl-edge",
    name: "Pearl Edge",
    material: "珍珠白",
    color: "白色",
    accent: "#f8f0dc",
    tint: "#eee4d1",
    widthRatio: 1.02,
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

const autoFitStatusLabels: Record<AutoFitStatus, string> = {
  settling: "稳定测量中",
  locked: "尺寸已锁定",
  adapting: "自动调整中",
};

const defaultGravity: Vector3 = { x: 0, y: 1, z: 0 };
const defaultAnchorOffset = 0.17;

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
  const [captureMessage, setCaptureMessage] = useState("");
  const [detectedHands, setDetectedHands] = useState(0);
  const [autoFitStatus, setAutoFitStatus] =
    useState<AutoFitStatus>("settling");
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [calibration, setCalibration] = useState<Calibration>({
    widthRatio: products[0].widthRatio,
    anchorOffset: defaultAnchorOffset,
  });
  const [debugFrame, setDebugFrame] = useState<DebugFrame | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayHostRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<{
    detectForVideo: (
      video: HTMLVideoElement,
      timestamp: number,
    ) => {
      landmarks: HandLandmark[][];
      worldLandmarks: HandLandmark[][];
      handedness: { categoryName?: string; score?: number }[][];
    };
    close?: () => void;
  } | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const frameLoopRef = useRef<(timestamp: number) => void>(() => undefined);
  const lastVideoTimeRef = useRef(-1);
  const lastFrameTimestampRef = useRef(0);
  const isActiveRef = useRef(false);
  const trackingRef = useRef(false);
  const detectedHandsRef = useRef(0);
  const selectedProductRef = useRef(products[0]);
  const calibrationRef = useRef(calibration);
  const calibrationOpenRef = useRef(false);
  const lastDebugUpdateRef = useRef(0);
  const selectedHandRef = useRef<HandednessLabel>("Unknown");
  const poseSmootherRef = useRef(new WristPoseSmoother());
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

  useEffect(() => {
    selectedProductRef.current = selectedProduct;
    rendererRef.current?.setAppearance({
      ...selectedProduct,
      widthRatio: calibrationRef.current.widthRatio,
    });
  }, [selectedProduct]);

  useEffect(() => {
    calibrationRef.current = calibration;
    rendererRef.current?.setAppearance({
      ...selectedProduct,
      widthRatio: calibration.widthRatio,
    });
  }, [calibration, selectedProduct]);

  useEffect(() => {
    calibrationOpenRef.current = calibrationOpen;
  }, [calibrationOpen]);

  const toggleCalibration = useCallback(() => {
    const nextOpen = !calibrationOpenRef.current;
    calibrationOpenRef.current = nextOpen;
    setCalibrationOpen(nextOpen);
    if (!nextOpen) {
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

  const updateTrackingState = useCallback((isTracking: boolean) => {
    if (trackingRef.current === isTracking) return;
    trackingRef.current = isTracking;
    setStatus(isTracking ? "tracking" : "ready");
  }, []);

  const updateDetectedHands = useCallback((count: number) => {
    if (detectedHandsRef.current === count) return;
    detectedHandsRef.current = count;
    setDetectedHands(count);
  }, []);

  const updateAutoFitStatus = useCallback((nextStatus: AutoFitStatus) => {
    if (autoFitStatusRef.current === nextStatus) return;
    autoFitStatusRef.current = nextStatus;
    setAutoFitStatus(nextStatus);
  }, []);

  const frameLoop = useCallback(
    (timestamp: number) => {
      const video = videoRef.current;
      const landmarker = handLandmarkerRef.current;
      const renderer = rendererRef.current;

      if (!isActiveRef.current || !video || !landmarker || !renderer) return;

      resizeOverlay();
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (lastVideoTimeRef.current !== video.currentTime) {
          try {
            const result = landmarker.detectForVideo(video, timestamp);
            lastVideoTimeRef.current = video.currentTime;
            updateDetectedHands(result.landmarks.length);

            const selectedIndex = selectPrimaryHand(
              result.landmarks,
              result.handedness,
              selectedHandRef.current,
            );
            const selectedLandmarks =
              selectedIndex >= 0 ? result.landmarks[selectedIndex] : undefined;
            const selectedWorldLandmarks =
              selectedIndex >= 0
                ? result.worldLandmarks[selectedIndex]
                : undefined;
            const category = result.handedness[selectedIndex]?.[0]?.categoryName;
            const handedness: HandednessLabel =
              category === "Left" || category === "Right"
                ? category
                : "Unknown";
            const sourceAspect =
              (video.videoWidth || 4) / (video.videoHeight || 3);
            const rawPose = selectedLandmarks
              ? calculateWristPose(
                  selectedLandmarks,
                  selectedWorldLandmarks,
                  handedness,
                  {
                    anchorOffset: calibrationRef.current.anchorOffset,
                    sourceAspect,
                  },
                )
              : null;
            const handScore =
              result.handedness[selectedIndex]?.[0]?.score ?? 1;
            const confidenceAdjustedPose = rawPose
              ? {
                  ...rawPose,
                  confidence: Math.min(rawPose.confidence, handScore),
                }
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
            const pose = displayPose
              ? poseSmootherRef.current.update(displayPose, timestamp)
              : poseSmootherRef.current.hold(timestamp);
            // Keep position and orientation smooth, but let auto-fit see the
            // current frame's scale signal so approach/recede movements do not
            // inherit the pose filter's visual latency.
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
              pose && fitResult?.wristWidth
                ? { ...pose, wristWidth: fitResult.wristWidth }
                : pose;
            if (fitResult) updateAutoFitStatus(fitResult.status);

            if (
              calibrationOpenRef.current &&
              timestamp - lastDebugUpdateRef.current >= 100
            ) {
                setDebugFrame({
                  landmarks: selectedLandmarks ?? [],
                  pose: renderPose,
                sourceAspect,
                stageAspect,
              });
              lastDebugUpdateRef.current = timestamp;
            }

            if (displayPose) {
              selectedHandRef.current = displayPose.handedness;
            }

            const elapsedSeconds =
              lastFrameTimestampRef.current > 0
                ? (timestamp - lastFrameTimestampRef.current) / 1000
                : 1 / 60;
            lastFrameTimestampRef.current = timestamp;

            if (renderPose) {
              const gravityTarget = projectGravityToWristPlane(
                renderPose,
                gravityRef.current,
              );
              const physics = physicsRef.current.update(
                gravityTarget.targetRoll,
                gravityTarget.alongArm,
                elapsedSeconds,
              );
              const heldPosition = !displayPose;
              const opacity =
                Math.min(1, 0.72 + renderPose.confidence * 0.3) *
                (heldPosition ? 0.46 : 1);
              renderer.render(renderPose, physics, opacity);
              updateTrackingState(true);
            } else {
              renderer.clear();
              updateTrackingState(false);
            }
          } catch {
            isActiveRef.current = false;
            trackingRef.current = false;
            updateDetectedHands(0);
            poseSmootherRef.current.reset();
            scaleControllerRef.current.reset();
            updateAutoFitStatus("settling");
            physicsRef.current.reset();
            setDebugFrame(null);
            renderer.clear();
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            video.srcObject = null;
            setStatus("error");
            setErrorMessage("手部识别运行异常，请重新启动相机。");
            return;
          }
        }
      }

      animationFrameRef.current = requestAnimationFrame((nextTimestamp) => {
        frameLoopRef.current(nextTimestamp);
      });
    },
    [
      resizeOverlay,
      updateAutoFitStatus,
      updateDetectedHands,
      updateTrackingState,
    ],
  );

  useEffect(() => {
    frameLoopRef.current = frameLoop;
  }, [frameLoop]);

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
    if (handLandmarkerRef.current) return;

    const { FilesetResolver, HandLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    configureMediaPipeRuntimeLogging();
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm",
    );

    const modelAssetPath =
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
    const options = {
      runningMode: "VIDEO" as const,
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    };

    try {
      handLandmarkerRef.current = await HandLandmarker.createFromOptions(
        vision,
        {
          ...options,
          baseOptions: { modelAssetPath, delegate: "GPU" },
        },
      );
    } catch {
      handLandmarkerRef.current = await HandLandmarker.createFromOptions(
        vision,
        {
          ...options,
          baseOptions: { modelAssetPath, delegate: "CPU" },
        },
      );
    }
  }, []);

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

    setErrorMessage("");
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
          width: { ideal: 960, max: 1280 },
          height: { ideal: 720, max: 960 },
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
      isActiveRef.current = true;
      trackingRef.current = false;
      detectedHandsRef.current = 0;
      selectedHandRef.current = "Unknown";
      gravityRef.current = defaultGravity;
      poseSmootherRef.current.reset();
      scaleControllerRef.current.reset();
      updateAutoFitStatus("settling");
      physicsRef.current.reset();
      setDetectedHands(0);
      setStatus("ready");
      animationFrameRef.current = requestAnimationFrame(frameLoop);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (motionHandlerRef.current) {
        window.removeEventListener("devicemotion", motionHandlerRef.current);
        motionHandlerRef.current = null;
      }
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "摄像头启动失败，请重试",
      );
    }
  }, [
    enableDeviceMotion,
    frameLoop,
    prepareHandLandmarker,
    resizeOverlay,
    status,
    updateAutoFitStatus,
  ]);

  const stopCamera = useCallback(() => {
    isActiveRef.current = false;
    trackingRef.current = false;
    detectedHandsRef.current = 0;
    selectedHandRef.current = "Unknown";
    poseSmootherRef.current.reset();
    scaleControllerRef.current.reset();
    updateAutoFitStatus("settling");
    physicsRef.current.reset();
    setDebugFrame(null);
    rendererRef.current?.clear();
    setDetectedHands(0);
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (motionHandlerRef.current) {
      window.removeEventListener("devicemotion", motionHandlerRef.current);
      motionHandlerRef.current = null;
    }
    setStatus("idle");
  }, [updateAutoFitStatus]);

  useEffect(() => {
    const handleResize = () => resizeOverlay();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      stopCamera();
      handLandmarkerRef.current?.close?.();
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
      setCaptureMessage("截图已下载");
      window.setTimeout(() => setCaptureMessage(""), 2400);
    }, "image/png");
  }, [selectedProduct.id]);

  const shareTryOn = useCallback(async () => {
    const shareData = {
      title: `AR 首饰试戴 · ${selectedProduct.name}`,
      text: `试戴 ${selectedProduct.name} ${selectedProduct.material}`,
      url: window.location.href,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(window.location.href);
      setCaptureMessage("试戴链接已复制");
      window.setTimeout(() => setCaptureMessage(""), 2400);
    } catch {
      setCaptureMessage("分享已取消");
      window.setTimeout(() => setCaptureMessage(""), 1800);
    }
  }, [selectedProduct]);

  const statusClass = status === "tracking" ? "is-live" : `is-${status}`;
  const cameraPrompt =
    status === "loading"
      ? "正在连接摄像头"
      : status === "ready"
        ? "请将整只手和手腕放入取景框"
        : status === "error"
          ? errorMessage
          : "启动相机后开始识别";
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
                {status === "error" && <small>检查权限后再次尝试</small>}
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
              <span>
                {status === "tracking"
                  ? "6DOF LOCKED"
                  : `HANDS: ${detectedHands}`}
              </span>
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
                    setCalibration({
                      widthRatio: selectedProduct.widthRatio,
                      anchorOffset: defaultAnchorOffset,
                    })
                  }
                  title="恢复当前款式默认值"
                  aria-label="恢复当前款式默认值"
                >
                  <RotateCcw size={16} />
                </button>
              </div>

              <label className="calibration-control">
                <span>
                  <span>手链大小</span>
                  <output>{Math.round(calibration.widthRatio * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0.82"
                  max="1.35"
                  step="0.01"
                  value={calibration.widthRatio}
                  onChange={(event) =>
                    setCalibration((current) => ({
                      ...current,
                      widthRatio: Number(event.target.value),
                    }))
                  }
                />
              </label>

              <label className="calibration-control">
                <span>
                  <span>腕部前后位置</span>
                  <output>{Math.round(calibration.anchorOffset * 100)}%</output>
                </span>
                <input
                  type="range"
                  min="0.04"
                  max="0.3"
                  step="0.01"
                  value={calibration.anchorOffset}
                  onChange={(event) =>
                    setCalibration((current) => ({
                      ...current,
                      anchorOffset: Number(event.target.value),
                    }))
                  }
                />
              </label>

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
                      setCalibration({
                        widthRatio: product.widthRatio,
                        anchorOffset: defaultAnchorOffset,
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
            >
              <span>查看购买页</span>
              <ExternalLink size={16} />
            </a>
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
