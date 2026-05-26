import { describe, it, expect } from "vitest";
import { classifyCameraCapabilities } from "./camera-diagnostics";

describe("classifyCameraCapabilities", () => {
  it("HTTPS with all APIs available — full capability", () => {
    const result = classifyCameraCapabilities({
      isSecureContext: true,
      hasCameraApi: true,
      hasBarcodeDetector: true,
    });
    expect(result.isSecureContext).toBe(true);
    expect(result.hasCameraApi).toBe(true);
    expect(result.hasBarcodeDetector).toBe(true);
    expect(result.hasJsQrFallback).toBe(true);
  });

  it("HTTP context — isSecureContext false, no camera API (getUserMedia unavailable)", () => {
    const result = classifyCameraCapabilities({
      isSecureContext: false,
      hasCameraApi: false,
      hasBarcodeDetector: false,
    });
    expect(result.isSecureContext).toBe(false);
    expect(result.hasCameraApi).toBe(false);
    expect(result.hasBarcodeDetector).toBe(false);
    expect(result.hasJsQrFallback).toBe(true);
  });

  it("iOS Safari — HTTPS, camera API yes, BarcodeDetector no, jsQR handles it", () => {
    const result = classifyCameraCapabilities({
      isSecureContext: true,
      hasCameraApi: true,
      hasBarcodeDetector: false,
    });
    expect(result.isSecureContext).toBe(true);
    expect(result.hasCameraApi).toBe(true);
    expect(result.hasBarcodeDetector).toBe(false);
    expect(result.hasJsQrFallback).toBe(true);
  });

  it("Android Chrome — HTTPS, camera API yes, BarcodeDetector yes", () => {
    const result = classifyCameraCapabilities({
      isSecureContext: true,
      hasCameraApi: true,
      hasBarcodeDetector: true,
    });
    expect(result.hasBarcodeDetector).toBe(true);
    expect(result.hasJsQrFallback).toBe(true);
  });

  it("hasJsQrFallback is always true regardless of other capabilities", () => {
    const result = classifyCameraCapabilities({
      isSecureContext: false,
      hasCameraApi: false,
      hasBarcodeDetector: false,
    });
    expect(result.hasJsQrFallback).toBe(true);
  });
});
