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
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  calculateWristTransform,
  drawBracelet,
  drawHandLandmarks,
  eraseWristOcclusion,
  type HandLandmark,
  WristTransformSmoother,
} from "@/lib/tryon-core";
import { configureMediaPipeRuntimeLogging } from "@/lib/mediapipe-runtime";

type CameraStatus = "idle" | "loading" | "ready" | "tracking" | "error";

type Product = {
  id: string;
  name: string;
  material: string;
  color: string;
  accent: string;
  tint: string;
  buyUrl: string;
};

const products: Product[] = [
  {
    id: "aurora-gold",
    name: "Aurora",
    material: "18K 黄金",
    color: "金色",
    accent: "#c89b52",
    tint: "#d9a441",
    buyUrl: "https://example.com/products/aurora",
  },
  {
    id: "mist-silver",
    name: "Mist",
    material: "925 银",
    color: "银色",
    accent: "#aeb7bf",
    tint: "#d8e0e5",
    buyUrl: "https://example.com/products/mist",
  },
  {
    id: "rose-line",
    name: "Rose Line",
    material: "玫瑰金",
    color: "玫瑰金",
    accent: "#c98673",
    tint: "#d6957e",
    buyUrl: "https://example.com/products/rose-line",
  },
  {
    id: "onyx-link",
    name: "Onyx Link",
    material: "黑金",
    color: "黑色",
    accent: "#58606a",
    tint: "#4a5059",
    buyUrl: "https://example.com/products/onyx-link",
  },
  {
    id: "pearl-edge",
    name: "Pearl Edge",
    material: "珍珠白",
    color: "白色",
    accent: "#d7d1c4",
    tint: "#eee4d1",
    buyUrl: "https://example.com/products/pearl-edge",
  },
];

const statusLabels: Record<CameraStatus, string> = {
  idle: "相机未启动",
  loading: "正在准备",
  ready: "等待手腕",
  tracking: "识别中",
  error: "需要检查",
};

export default function Home() {
  const [selectedProductId, setSelectedProductId] = useState(products[0].id);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [captureMessage, setCaptureMessage] = useState("");
  const [detectedHands, setDetectedHands] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<{
    detectForVideo: (
      video: HTMLVideoElement,
      timestamp: number,
    ) => {
      landmarks: HandLandmark[][];
      worldLandmarks: HandLandmark[][];
      handedness: { categoryName?: string }[][];
    };
    close?: () => void;
  } | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const frameLoopRef = useRef<(timestamp: number) => void>(() => undefined);
  const lastVideoTimeRef = useRef(-1);
  const isActiveRef = useRef(false);
  const trackingRef = useRef(false);
  const detectedHandsRef = useRef(0);
  const selectedProductRef = useRef(products[0]);
  const transformSmootherRef = useRef(new WristTransformSmoother());
  const lastHandRef = useRef<HandLandmark[] | null>(null);

  const selectedProduct =
    products.find((product) => product.id === selectedProductId) ?? products[0];

  useEffect(() => {
    selectedProductRef.current = selectedProduct;
  }, [selectedProduct]);

  const resizeCanvas = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const width = video.videoWidth || 960;
    const height = video.videoHeight || 720;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
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

  const frameLoop = useCallback(
    (timestamp: number) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const landmarker = handLandmarkerRef.current;

      if (!isActiveRef.current || !video || !canvas || !landmarker) return;

      resizeCanvas();
      const context = canvas.getContext("2d");
      if (!context) return;

      context.clearRect(0, 0, canvas.width, canvas.height);

      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        if (lastVideoTimeRef.current !== video.currentTime) {
          try {
            const result = landmarker.detectForVideo(video, timestamp);
            lastVideoTimeRef.current = video.currentTime;
            updateDetectedHands(result.landmarks.length);

            const firstHand = result.landmarks[0];
            const firstWorldHand = result.worldLandmarks[0];
            const rawTransform = firstHand
              ? calculateWristTransform(firstHand, firstWorldHand)
              : null;
            if (firstHand) {
              lastHandRef.current = firstHand;
            }

            const transform = rawTransform
              ? transformSmootherRef.current.update(rawTransform, timestamp)
              : transformSmootherRef.current.hold(timestamp);

            if (!transform) {
              lastHandRef.current = null;
            }

            if (transform && lastHandRef.current) {
              const isHeldPosition = !rawTransform;
              const opacity =
                Math.min(1, 0.72 + transform.confidence * 0.3) *
                (isHeldPosition ? 0.72 : 1);

              drawBracelet(context, transform, {
                tint: selectedProductRef.current.tint,
                opacity,
                layer: "top",
              });
              eraseWristOcclusion(context, lastHandRef.current);
              drawBracelet(context, transform, {
                tint: selectedProductRef.current.tint,
                opacity,
                layer: "bottom",
              });
              updateTrackingState(true);
            } else {
              updateTrackingState(false);
            }

            drawHandLandmarks(context, result.landmarks);
          } catch {
            isActiveRef.current = false;
            trackingRef.current = false;
            updateDetectedHands(0);
            transformSmootherRef.current.reset();
            lastHandRef.current = null;
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            video.srcObject = null;
            context.clearRect(0, 0, canvas.width, canvas.height);
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
    [resizeCanvas, updateDetectedHands, updateTrackingState],
  );

  useEffect(() => {
    frameLoopRef.current = frameLoop;
  }, [frameLoop]);

  const prepareHandLandmarker = useCallback(async () => {
    if (handLandmarkerRef.current) return;

    const { FilesetResolver, HandLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    configureMediaPipeRuntimeLogging();
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm",
    );

    handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
  }, []);

  const startCamera = useCallback(async () => {
    if (status === "loading") return;

    setErrorMessage("");
    setCaptureMessage("");
    setStatus("loading");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前浏览器不支持摄像头");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
      });

      await prepareHandLandmarker();

      const video = videoRef.current;
      if (!video) throw new Error("摄像头画面初始化失败");

      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      resizeCanvas();
      lastVideoTimeRef.current = -1;
      isActiveRef.current = true;
      trackingRef.current = false;
      detectedHandsRef.current = 0;
      transformSmootherRef.current.reset();
      lastHandRef.current = null;
      setDetectedHands(0);
      setStatus("ready");
      animationFrameRef.current = requestAnimationFrame(frameLoop);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus("error");
      setErrorMessage(
        error instanceof Error ? error.message : "摄像头启动失败，请重试",
      );
    }
  }, [frameLoop, prepareHandLandmarker, resizeCanvas, status]);

  const stopCamera = useCallback(() => {
    isActiveRef.current = false;
    trackingRef.current = false;
    detectedHandsRef.current = 0;
    transformSmootherRef.current.reset();
    lastHandRef.current = null;
    setDetectedHands(0);
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    const context = canvasRef.current?.getContext("2d");
    if (context && canvasRef.current) {
      context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    setStatus("idle");
  }, []);

  useEffect(() => {
    const handleResize = () => resizeCanvas();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      stopCamera();
      handLandmarkerRef.current?.close?.();
    };
  }, [resizeCanvas, stopCamera]);

  const captureTryOn = useCallback(() => {
    const video = videoRef.current;
    const overlay = canvasRef.current;
    if (
      !video ||
      !overlay ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      setCaptureMessage("请先启动相机");
      return;
    }

    const output = document.createElement("canvas");
    output.width = video.videoWidth || overlay.width;
    output.height = video.videoHeight || overlay.height;
    const context = output.getContext("2d");
    if (!context) return;

    context.save();
    context.translate(output.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, output.width, output.height);
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
              <p className="eyebrow">LIVE FITTING</p>
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
            <canvas ref={canvasRef} className="tryon-overlay" aria-hidden="true" />

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

            <div className="stage-footer">
              <span>GEOMETRY READY</span>
              <span>
                {status === "tracking"
                  ? "LOCKED"
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
            {captureMessage && (
              <span className="action-message">{captureMessage}</span>
            )}
          </div>
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
                    onClick={() => setSelectedProductId(product.id)}
                  >
                    <span
                      className="product-swatch"
                      style={{
                        backgroundColor: product.accent,
                        boxShadow: `inset 0 0 0 1px ${product.accent}66`,
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
        <span>GEOMETRY AR</span>
      </footer>
    </main>
  );
}
