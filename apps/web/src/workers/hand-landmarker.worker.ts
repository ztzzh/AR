import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

import type { HandLandmarkerResult } from "../lib/tryon-core";

type InitializeMessage = {
  type: "initialize";
  modelAssetPath: string;
  wasmPath: string;
};

type DetectMessage = {
  type: "detect";
  frame: ImageBitmap;
  sessionId: number;
  timestamp: number;
  videoTime: number;
};

type WorkerMessage = InitializeMessage | DetectMessage;

type WorkerResponse =
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

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

let handLandmarker: HandLandmarker | null = null;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "手部模型初始化失败";

workerScope.onmessage = async (event) => {
  const message = event.data;

  if (message.type === "initialize") {
    try {
      const vision = await FilesetResolver.forVisionTasks(message.wasmPath);
      const options = {
        runningMode: "VIDEO" as const,
        numHands: 1,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      };

      try {
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          ...options,
          baseOptions: {
            modelAssetPath: message.modelAssetPath,
            delegate: "GPU",
          },
        });
      } catch {
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          ...options,
          baseOptions: {
            modelAssetPath: message.modelAssetPath,
            delegate: "CPU",
          },
        });
      }

      workerScope.postMessage({ type: "ready" });
    } catch (error) {
      workerScope.postMessage({ type: "error", message: errorMessage(error) });
    }
    return;
  }

  try {
    if (!handLandmarker) throw new Error("手部模型尚未准备完成");

    const inferenceStartedAt = performance.now();
    const result = handLandmarker.detectForVideo(message.frame, message.timestamp);
    const inferenceMs = performance.now() - inferenceStartedAt;
    message.frame.close();
    workerScope.postMessage({
      type: "result",
      result: {
        landmarks: result.landmarks,
        worldLandmarks: result.worldLandmarks,
        handedness: result.handedness,
      },
      sessionId: message.sessionId,
      timestamp: message.timestamp,
      videoTime: message.videoTime,
      inferenceMs,
    });
  } catch (error) {
    message.frame.close();
    workerScope.postMessage({
      type: "error",
      message: errorMessage(error),
      sessionId: message.sessionId,
    });
  }
};
