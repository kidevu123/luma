// Camera-scanner structural regression pins — MED 1 fix round 2.
//
// These 14 assertions used to live in scan-card-form.test.ts. When the
// Task 5 cutover deleted scan-card-form.tsx, that test file went with
// it and camera-scanner.tsx lost coverage that had nothing to do with
// the scan form — the FLOOR-SCAN-1 HTTPS refusal, the
// CAMERA-SCAN-ROOTCAUSE-1 black-screen fix, the NotAllowedError copy,
// and the stream teardown on both decode paths.
//
// camera-scanner.tsx is byte-identical to the pre-cutover version, so
// the assertions themselves are unchanged. The only adaptation is
// dropping the scan-card-form source read — this file scans
// camera-scanner.tsx directly.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cameraSrc = readFileSync(resolve(here, "camera-scanner.tsx"), "utf8");

// ── FLOOR-SCAN-1 · secure-context / HTTPS refusal (5 pins) ────────────────

describe("FLOOR-SCAN-1 · camera scanner HTTPS requirement", () => {
  it("camera-scanner.tsx checks window.isSecureContext", () => {
    expect(cameraSrc).toMatch(/isSecureContext/);
  });

  it("shows HTTPS-specific error when page is served over HTTP", () => {
    expect(cameraSrc).toMatch(/Camera access requires HTTPS/);
    expect(cameraSrc).toMatch(/This page is served over HTTP/);
  });

  it("shows browser-unsupported message when MediaDevices API is absent for non-insecure reasons", () => {
    expect(cameraSrc).toMatch(/not available in this browser/);
  });

  it("falls back to 'Use typed input' link when camera is unavailable", () => {
    expect(cameraSrc).toMatch(/Use typed input/);
  });

  it("camera decode result calls onResult — same handler as typed scan", () => {
    // Structural: both BarcodeDetector and jsQR paths call onResult(value)
    expect(cameraSrc).toMatch(/onResult\(/);
  });
});

// ── CAMERA-SCAN-ROOTCAUSE-1 · video DOM bug fix (9 pins) ──────────────────
//
// Root cause: <video> was inside {phase === "scanning" && ...}, so
// videoRef.current was null when the getUserMedia promise resolved.
// if (video) failed silently; setPhase("scanning") never called;
// scanner stayed on spinner forever. Fix: video always in DOM, hidden
// via CSS class when not scanning.

describe("CAMERA-SCAN-ROOTCAUSE-1 · camera-scanner.tsx video DOM fix", () => {
  it("video element is always rendered (phase check uses CSS hidden, not conditional rendering)", () => {
    // The video element must NOT be the direct child of {phase === "scanning" && ...}.
    // It should use conditional CSS class instead.
    expect(cameraSrc).toMatch(/phase !== "scanning"/);
  });

  it("video element uses Tailwind hidden class to toggle visibility when not scanning", () => {
    // className includes conditional: phase !== "scanning" ? " hidden" : ""
    expect(cameraSrc).toMatch(/phase !== "scanning".*hidden/);
  });

  it("setStreamStarted(true) called after getUserMedia succeeds", () => {
    expect(cameraSrc).toMatch(/setStreamStarted\(true\)/);
  });

  it("setPermissionDenied(true) called on NotAllowedError", () => {
    expect(cameraSrc).toMatch(/setPermissionDenied\(true\)/);
  });

  it("CameraDiagnosticsPanel rendered in the error phase", () => {
    expect(cameraSrc).toMatch(/CameraDiagnosticsPanel/);
  });

  it("diagnostics panel labels HTTPS secure context", () => {
    expect(cameraSrc).toMatch(/HTTPS secure context/);
  });

  it("diagnostics panel labels camera permission state", () => {
    expect(cameraSrc).toMatch(/Camera permission/);
  });

  it("stream is stopped after successful scan in BarcodeDetector path", () => {
    // stopStream() called before onResult in native path
    expect(cameraSrc).toMatch(/stopStream\(\)/);
    expect(cameraSrc).toMatch(/onResult\(barcodes/);
  });

  it("stream is stopped after successful scan in jsQR path", () => {
    // getTracks().forEach(t => t.stop()) called before onResult in jsQR path
    expect(cameraSrc).toMatch(/onResult\(code\.data\.trim\(\)\)/);
  });
});
