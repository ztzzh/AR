import {
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

import type {
  HandLandmarkerResult,
  PoseLandmarkerResult,
} from "../lib/tryon-core";

type InitializeMessage = {
  type: "initialize";
  modelAssetPath: string;
  poseModelAssetPath: string;
  wasmPath: string;
};

type DetectMessage = {
  type: "detect";
  frame: ImageBitmap;
  sessionId: number;
  timestamp: number;
  videoTime: number;
  includePose: boolean;
};

type WorkerMessage = InitializeMessage | DetectMessage;

type WorkerResponse =
  | { type: "ready"; poseAvailable: boolean; poseError?: string }
  | {
      type: "result";
      result: HandLandmarkerResult;
      poseResult?: PoseLandmarkerResult;
      poseError?: string;
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
let poseLandmarker: PoseLandmarker | null = null;

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

      let poseError: string | undefined;
      const poseOptions = {
        runningMode: "VIDEO" as const,
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      };
      try {
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          ...poseOptions,
          baseOptions: {
            modelAssetPath: message.poseModelAssetPath,
            delegate: "GPU",
          },
        });
      } catch {
        try {
          poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
            ...poseOptions,
            baseOptions: {
              modelAssetPath: message.poseModelAssetPath,
              delegate: "CPU",
            },
          });
        } catch (error) {
          poseLandmarker = null;
          poseError = errorMessage(error);
        }
      }

      workerScope.postMessage({
        type: "ready",
        poseAvailable: Boolean(poseLandmarker),
        poseError,
      });
    } catch (error) {
      workerScope.postMessage({ type: "error", message: errorMessage(error) });
    }
    return;
  }

  try {
    if (!handLandmarker) throw new Error("手部模型尚未准备完成");

    const inferenceStartedAt = performance.now();
    const result = handLandmarker.detectForVideo(message.frame, message.timestamp);
    let poseResult: PoseLandmarkerResult | undefined;
    let poseError: string | undefined;
    if (message.includePose) {
      if (poseLandmarker) {
        try {
          const detectedPose = poseLandmarker.detectForVideo(
            message.frame,
            message.timestamp,
          );
          poseResult = {
            landmarks: detectedPose.landmarks,
            worldLandmarks: detectedPose.worldLandmarks,
          };
          detectedPose.close();
        } catch (error) {
          poseLandmarker.close();
          poseLandmarker = null;
          poseError = errorMessage(error);
        }
      } else {
        poseError = "Pose 模型不可用";
      }
    }
    const inferenceMs = performance.now() - inferenceStartedAt;
    message.frame.close();
    workerScope.postMessage({
      type: "result",
      result: {
        landmarks: result.landmarks,
        worldLandmarks: result.worldLandmarks,
        handedness: result.handedness,
      },
      poseResult,
      poseError,
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
