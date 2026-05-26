// Pure helpers for diagnosing camera API availability in the browser.
// classifyCameraCapabilities is pure (no side-effects) and testable without a browser.
// getStaticCameraDiagnostics reads real browser globals for use inside React components.

export interface CameraDiagnostics {
  isSecureContext: boolean;
  hasCameraApi: boolean;
  hasBarcodeDetector: boolean;
  hasJsQrFallback: boolean;
}

export interface BrowserCapabilities {
  isSecureContext: boolean;
  hasCameraApi: boolean;
  hasBarcodeDetector: boolean;
}

// Pure classifier. Pass a BrowserCapabilities object (from tests or from real browser globals).
export function classifyCameraCapabilities(
  ctx: BrowserCapabilities,
): CameraDiagnostics {
  return {
    isSecureContext: ctx.isSecureContext,
    hasCameraApi: ctx.hasCameraApi,
    hasBarcodeDetector: ctx.hasBarcodeDetector,
    hasJsQrFallback: true, // jsQR is always bundled
  };
}

// Entry point for React components. Returns SSR-safe defaults when window is absent.
export function getStaticCameraDiagnostics(): CameraDiagnostics {
  if (typeof window === "undefined") {
    return classifyCameraCapabilities({
      isSecureContext: false,
      hasCameraApi: false,
      hasBarcodeDetector: false,
    });
  }
  return classifyCameraCapabilities({
    isSecureContext: window.isSecureContext,
    hasCameraApi: !!navigator.mediaDevices?.getUserMedia,
    hasBarcodeDetector: "BarcodeDetector" in window,
  });
}
