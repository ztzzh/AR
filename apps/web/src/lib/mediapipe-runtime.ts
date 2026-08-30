type EmscriptenModuleConfig = {
  printErr?: (message: unknown) => void;
};

type GlobalWithEmscriptenModule = typeof globalThis & {
  Module?: EmscriptenModuleConfig;
};

const XNNPACK_DELEGATE_LOG =
  "Created TensorFlow Lite XNNPACK delegate for CPU";

export function configureMediaPipeRuntimeLogging() {
  const runtime = globalThis as GlobalWithEmscriptenModule;
  const existingPrintErr = runtime.Module?.printErr;

  // MediaPipe's WASM bootstrap sends this informational startup line to stderr.
  runtime.Module = {
    ...runtime.Module,
    printErr(message) {
      if (String(message).includes(XNNPACK_DELEGATE_LOG)) return;

      if (existingPrintErr) {
        existingPrintErr(message);
        return;
      }

      console.error(message);
    },
  };
}
