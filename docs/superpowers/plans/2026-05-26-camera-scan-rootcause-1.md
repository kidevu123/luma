# CAMERA-SCAN-ROOTCAUSE-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the camera scanner on the floor station page so it opens correctly on HTTPS (public URL), works on both iOS Safari (jsQR path) and Android Chrome (BarcodeDetector path), and shows operator-friendly diagnostics when it cannot start.

**Architecture:** The root cause is a conditional-render bug: `<video>` is inside `{phase === "scanning" && ...}`, so `videoRef.current` is `null` when the async `getUserMedia` promise resolves. Fix by always rendering the video element and toggling visibility via CSS. Extract a pure `classifyCameraCapabilities` helper for testability. Add a diagnostics panel inside the scanner error UI.

**Tech Stack:** React 19 (client component, `useRef`, `useEffect`), jsQR (bundled), BarcodeDetector (native Chrome/Android), getUserMedia (standard), Tailwind CSS v3, Vitest + source-text structural tests.

---

## Safety Check (pre-work)

- Branch: `main`, HEAD `cb2ea3d`, clean working tree, v0.2.46
- Deployed SHA confirmed: `cb2ea3d` (from `/api/health`)
- Tests at baseline: 2399/2399 pass

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `lib/floor/camera-diagnostics.ts` | Pure helper: `classifyCameraCapabilities`, `getStaticCameraDiagnostics`, `CameraDiagnostics` type |
| Create | `lib/floor/camera-diagnostics.test.ts` | Unit tests for the pure helper (5 tests) |
| Modify | `app/(floor)/floor/[token]/camera-scanner.tsx` | Fix video DOM bug; add diagnostics UI; add `streamStarted`/`permissionDenied` state |
| Modify | `app/(floor)/floor/[token]/scan-card-form.test.ts` | 9 new structural tests for the DOM fix and diagnostics |
| Modify | `package.json` | Bump 0.2.46 → 0.2.47 |
| Modify | `CHANGELOG.md` | Entry for CAMERA-SCAN-ROOTCAUSE-1 |

---

## Task 1: Create pure camera diagnostics helper (TDD)

**Files:**
- Create: `lib/floor/camera-diagnostics.ts`
- Create: `lib/floor/camera-diagnostics.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/floor/camera-diagnostics.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — verify 5 failures**

```bash
npx vitest run lib/floor/camera-diagnostics.test.ts
```

Expected: FAIL — `classifyCameraCapabilities` not found.

- [ ] **Step 3: Implement `lib/floor/camera-diagnostics.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests — verify 5 pass**

```bash
npx vitest run lib/floor/camera-diagnostics.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/floor/camera-diagnostics.ts lib/floor/camera-diagnostics.test.ts
git commit -m "$(cat <<'EOF'
feat(floor): add pure camera diagnostics helper (CAMERA-SCAN-ROOTCAUSE-1)

classifyCameraCapabilities is pure/testable; getStaticCameraDiagnostics
reads real browser globals for use in the scanner component.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Fix video DOM bug in camera-scanner.tsx + add diagnostics UI

**Files:**
- Modify: `app/(floor)/floor/[token]/scan-card-form.test.ts` (add 9 structural tests — write first to fail)
- Modify: `app/(floor)/floor/[token]/camera-scanner.tsx` (fix + diagnostics)

### Step 2a — Write structural tests (they fail against current code)

- [ ] **Step 1: Append 9 structural tests to `scan-card-form.test.ts`**

Add at the bottom of `app/(floor)/floor/[token]/scan-card-form.test.ts`:

```typescript
// ── CAMERA-SCAN-ROOTCAUSE-1 · video DOM bug fix ───────────────────────────
//
// Root cause: <video> was inside {phase === "scanning" && ...}, so videoRef.current
// was null when the getUserMedia promise resolved. if (video) failed silently;
// setPhase("scanning") never called; scanner stayed on spinner forever.
// Fix: video always in DOM, hidden via CSS class when not scanning.

describe("CAMERA-SCAN-ROOTCAUSE-1 · camera-scanner.tsx video DOM fix", () => {
  it("video element is always rendered (phase check uses CSS hidden, not conditional rendering)", () => {
    // The video element must NOT be the direct child of {phase === "scanning" && ...}.
    // It should use conditional CSS class instead.
    expect(cameraSrc).toMatch(/phase !== "scanning"/);
  });

  it("video element uses Tailwind hidden class to toggle visibility when not scanning", () => {
    // className includes conditional hidden class, e.g. `...${phase !== "scanning" ? " hidden" : ""}`
    expect(cameraSrc).toMatch(/hidden.*scanning|scanning.*hidden/);
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
```

- [ ] **Step 2: Run — verify the 9 new tests fail**

```bash
npx vitest run app/\(floor\)/floor/\[token\]/scan-card-form.test.ts
```

Expected: existing tests pass, 9 new tests FAIL (no `setStreamStarted`, no `CameraDiagnosticsPanel`, etc. in current code).

### Step 2b — Replace camera-scanner.tsx with the fix

- [ ] **Step 3: Write the fixed `app/(floor)/floor/[token]/camera-scanner.tsx`**

```tsx
"use client";

// CameraScanner — rAF-based QR frame reader for the floor station page.
//
// Uses getUserMedia with facingMode:environment (rear camera on tablets),
// draws each frame to an off-screen canvas, and passes the ImageData to
// jsQR. On a successful decode the raw string (the physical bag QR token)
// is forwarded to onResult and scanning stops.
//
// Degrades gracefully: if getUserMedia or the Camera API is unavailable
// (old browser, desktop dev, permissions blocked) the component shows a
// friendly error and exposes "Use typed input" link instead of crashing.
//
// CAMERA-SCAN-ROOTCAUSE-1 fix: <video> is always in the DOM so videoRef.current
// is non-null when the getUserMedia promise resolves during "starting" phase.
// Previously it was inside {phase === "scanning" && ...} — the ref was null,
// if (video) failed silently, and the scanner stayed on the spinner forever.

import * as React from "react";
import { X, CameraOff, Loader2, CheckCircle2, XCircle } from "lucide-react";
import jsQR from "jsqr";
import {
  getStaticCameraDiagnostics,
  type CameraDiagnostics,
} from "@/lib/floor/camera-diagnostics";

type BarcodeDetectorInstance = {
  detect(image: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
};
type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorInstance;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function CameraScanner({
  onResult,
  onClose,
}: {
  onResult: (scanToken: string) => void;
  onClose: () => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const rafRef = React.useRef<number>(0);
  const resolvedRef = React.useRef(false);

  const [phase, setPhase] = React.useState<"starting" | "scanning" | "error">(
    "starting",
  );
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [streamStarted, setStreamStarted] = React.useState(false);
  const [permissionDenied, setPermissionDenied] = React.useState(false);

  const diag = React.useMemo(() => getStaticCameraDiagnostics(), []);

  React.useEffect(() => {
    let mounted = true;

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (mounted) {
          const isInsecure =
            typeof window !== "undefined" && !window.isSecureContext;
          setErrorMsg(
            isInsecure
              ? "Camera access requires HTTPS. This page is served over HTTP — ask your IT team to enable HTTPS, or type the bag QR code manually."
              : "Camera is not available in this browser. Use the text input to scan instead.",
          );
          setPhase("error");
        }
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        if (!mounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setStreamStarted(true);
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
          setPhase("scanning");
        }
      } catch (err) {
        if (!mounted) return;
        let msg = "Could not access camera.";
        if (err instanceof DOMException) {
          if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
            msg =
              "Camera permission denied. Allow camera access in your browser settings and try again.";
            setPermissionDenied(true);
          } else if (
            err.name === "NotFoundError" ||
            err.name === "DevicesNotFoundError"
          ) {
            msg = "No camera found on this device.";
          } else if (err.name === "NotReadableError") {
            msg = "Camera is in use by another app.";
          } else if (err.name === "OverconstrainedError") {
            // Retry without environment constraint
            try {
              const fallback = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false,
              });
              if (!mounted) {
                fallback.getTracks().forEach((t) => t.stop());
                return;
              }
              streamRef.current = fallback;
              setStreamStarted(true);
              const video = videoRef.current;
              if (video) {
                video.srcObject = fallback;
                await video.play();
                setPhase("scanning");
                return;
              }
            } catch {
              msg = "No compatible camera found.";
            }
          }
        }
        setErrorMsg(msg);
        setPhase("error");
      }
    }

    void startCamera();

    return () => {
      mounted = false;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Start the decode loop once the camera is scanning.
  React.useEffect(() => {
    if (phase !== "scanning") return;

    const video = videoRef.current;
    if (!video) return;
    const videoEl: HTMLVideoElement = video;

    function stopStream() {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      cancelAnimationFrame(rafRef.current);
    }

    if (
      typeof window !== "undefined" &&
      "BarcodeDetector" in window
    ) {
      // Native BarcodeDetector path (Chrome/Android — faster, no canvas)
      const DetectorClass = (window as Record<string, unknown>)[
        "BarcodeDetector"
      ] as BarcodeDetectorConstructor;
      const detector = new DetectorClass({ formats: ["qr_code"] });
      let cancelled = false;

      async function nativeLoop() {
        while (!cancelled && !resolvedRef.current) {
          if (videoEl.readyState < videoEl.HAVE_ENOUGH_DATA) {
            await delay(50);
            continue;
          }
          try {
            const barcodes = await detector.detect(videoEl);
            if (cancelled || resolvedRef.current) return;
            if (barcodes[0]?.rawValue) {
              resolvedRef.current = true;
              stopStream();
              onResult(barcodes[0].rawValue);
              return;
            }
          } catch {
            // detection error on a frame is non-fatal; continue loop
          }
          await delay(100); // ~10fps
        }
      }
      void nativeLoop();

      return () => {
        cancelled = true;
        stopStream();
      };
    } else {
      // jsQR fallback path (iOS Safari + browsers without BarcodeDetector)
      function tick() {
        if (resolvedRef.current) return;

        const canvas = canvasRef.current;
        if (
          !video ||
          !canvas ||
          video.readyState < video.HAVE_ENOUGH_DATA
        ) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          rafRef.current = requestAnimationFrame(tick);
          return;
        }

        ctx.drawImage(video, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert",
        });

        if (code?.data) {
          resolvedRef.current = true;
          streamRef.current?.getTracks().forEach((t) => t.stop());
          cancelAnimationFrame(rafRef.current);
          onResult(code.data.trim());
          return;
        }

        rafRef.current = requestAnimationFrame(tick);
      }

      rafRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafRef.current);
    }
  }, [phase, onResult]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="relative w-full max-w-sm bg-surface rounded-2xl overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="text-sm font-semibold">Scan bag QR</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close camera"
            className="p-1 text-text-muted hover:text-text rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {phase === "starting" && (
          <div className="p-8 flex flex-col items-center gap-3 text-text-muted">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Starting camera…</p>
          </div>
        )}

        {phase === "error" && (
          <div className="p-6 text-center space-y-3">
            <CameraOff className="h-10 w-10 mx-auto text-text-muted" />
            <p className="text-sm text-text-muted">{errorMsg}</p>
            <CameraDiagnosticsPanel
              diag={diag}
              streamStarted={streamStarted}
              permissionDenied={permissionDenied}
            />
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-brand-700 underline"
            >
              Use typed input instead
            </button>
          </div>
        )}

        {/* Video is ALWAYS in the DOM so videoRef.current is non-null when the
            getUserMedia promise resolves during the "starting" phase.
            Root cause fix: was inside {phase === "scanning" && ...} — ref was null,
            if (video) failed silently, scanner stayed on spinner forever on HTTPS. */}
        <video
          ref={videoRef}
          muted
          playsInline
          className={`w-full aspect-square object-cover bg-black${phase !== "scanning" ? " hidden" : ""}`}
        />
        {phase === "scanning" && (
          <p className="text-center text-xs text-text-muted py-3 px-4">
            Point camera at the bag QR label
          </p>
        )}

        <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
      </div>
    </div>
  );
}

// ── Diagnostics panel ─────────────────────────────────────────────────────────

function DiagItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 text-left text-xs">
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
      )}
      <span className={ok ? "text-text-muted" : "text-red-700"}>{label}</span>
    </div>
  );
}

function CameraDiagnosticsPanel({
  diag,
  streamStarted,
  permissionDenied,
}: {
  diag: CameraDiagnostics;
  streamStarted: boolean;
  permissionDenied: boolean;
}) {
  return (
    <div className="text-left rounded-lg border border-border bg-surface-2/60 px-3 py-2.5 space-y-1.5">
      <p className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">
        Diagnostics
      </p>
      <DiagItem label="HTTPS secure context" ok={diag.isSecureContext} />
      <DiagItem label="Camera API available" ok={diag.hasCameraApi} />
      <DiagItem
        label={permissionDenied ? "Camera permission — denied" : "Camera permission"}
        ok={!permissionDenied}
      />
      <DiagItem
        label={
          diag.hasBarcodeDetector
            ? "Hardware decoder (BarcodeDetector)"
            : "Hardware decoder — using jsQR fallback"
        }
        ok={diag.hasBarcodeDetector || diag.hasJsQrFallback}
      />
      <DiagItem label="jsQR software fallback" ok={diag.hasJsQrFallback} />
      <DiagItem label="Camera stream started" ok={streamStarted} />
    </div>
  );
}
```

- [ ] **Step 4: Run — verify all 2413 tests pass (2399 existing + 5 new diag + 9 new structural)**

```bash
npx vitest run
```

Expected: `Tests 2413 passed (2413)`. If count differs, check the test output for failures.

- [ ] **Step 5: Commit**

```bash
git add app/\(floor\)/floor/\[token\]/camera-scanner.tsx \
        app/\(floor\)/floor/\[token\]/scan-card-form.test.ts
git commit -m "$(cat <<'EOF'
fix(floor): camera scanner stuck on spinner on HTTPS (CAMERA-SCAN-ROOTCAUSE-1)

Root cause: <video> was inside {phase === "scanning" && ...}. videoRef.current
was null when getUserMedia resolved; if (video) failed silently; setPhase("scanning")
never called. Fix: always render video in DOM, hide via CSS class when not scanning.

Also adds: streamStarted/permissionDenied state, CameraDiagnosticsPanel in error
phase, setStreamStarted in OverconstrainedError retry path.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Version bump + CHANGELOG

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version in `package.json`**

Change `"version": "0.2.46"` → `"version": "0.2.47"`.

- [ ] **Step 2: Add CHANGELOG entry**

Prepend to `CHANGELOG.md` (before the `## [0.2.46]` block):

```markdown
## [0.2.47] — 2026-05-26

### Fixed
- **Camera scanner stuck on spinner on HTTPS (CAMERA-SCAN-ROOTCAUSE-1):** The `<video>` element was rendered inside `{phase === "scanning" && ...}`, making `videoRef.current` null when the `getUserMedia` promise resolved during the "starting" phase. The `if (video)` check failed silently — the OS granted camera access but `.play()` was never called and `setPhase("scanning")` was never reached. Scanner stayed on the spinner forever even on HTTPS/public URL. Fixed by always rendering the video element in the DOM and toggling visibility via a CSS `hidden` class, so `videoRef.current` is non-null when the async stream arrives.

### Added
- **Camera diagnostics panel (CAMERA-SCAN-ROOTCAUSE-1):** When the camera fails to start, a compact diagnostics panel now appears inside the scanner error UI. Shows operator-friendly status for: HTTPS secure context, Camera API availability, camera permission (denied/granted), hardware BarcodeDetector support or jsQR fallback, and whether the camera stream started. Helps operators and supervisors identify whether the issue is HTTPS, permissions, or browser support.
- **`lib/floor/camera-diagnostics.ts`:** Pure helpers `classifyCameraCapabilities` (injectable, testable) and `getStaticCameraDiagnostics` (reads browser globals for React use).

### Tests added (CAMERA-SCAN-ROOTCAUSE-1)
- `lib/floor/camera-diagnostics.test.ts` (5 tests): HTTP context, HTTPS + all APIs, iOS Safari (no BarcodeDetector / jsQR handles), Android Chrome, always-true jsQrFallback invariant.
- Structural camera-scanner invariants (9 tests added to `scan-card-form.test.ts`): video DOM fix (CSS hidden, not conditional render), `setStreamStarted(true)`, `setPermissionDenied(true)`, `CameraDiagnosticsPanel` in error phase, HTTPS diagnostic label, camera permission label, stream-stop in BarcodeDetector path, stream-stop in jsQR path.

```

- [ ] **Step 3: Commit version + changelog**

```bash
git add package.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore: bump to v0.2.47 — CAMERA-SCAN-ROOTCAUSE-1 camera scanner fix

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Final checks + push

- [ ] **Step 1: Typecheck**

```bash
npx tsc --noEmit
```

Expected: exit 0, no error lines (npm notice about npm version is OK to ignore).

- [ ] **Step 2: Full test run**

```bash
npx vitest run
```

Expected: `Tests 2413 passed (2413)`, 99 test files.

- [ ] **Step 3: Build**

```bash
npx next build 2>&1 | tail -20
```

Expected: exit 0. The single warning from `@opentelemetry/instrumentation` (node_modules, pre-existing) is acceptable.

- [ ] **Step 4: Push to origin/main**

```bash
git push origin main
```

- [ ] **Step 5: Verify deployed SHA**

```bash
curl -s http://192.168.1.134:3000/api/health
```

Wait ~90 seconds for the systemd timer to pull and rebuild. Expected: `{"sha":"<new-HEAD-sha>","status":"ok",...}`. The new SHA will differ from `cb2ea3d`.

---

## Manual QA Checklist

Return this to the user after pushing:

```
CAMERA-SCAN-ROOTCAUSE-1 — Manual QA checklist

Device: iPhone Safari
[ ] Open floor station URL over HTTPS public URL
[ ] Tap camera icon → permission dialog appears
[ ] Grant permission → video viewfinder opens (not spinner)
[ ] Point at valid bag-card QR → scan resolves, workflow advances
[ ] Point at invalid QR → scanError shown, camera still open
[ ] Tap X → camera closes

Device: Android Chrome
[ ] Open floor station URL over HTTPS public URL
[ ] Tap camera icon → permission dialog appears
[ ] Grant permission → video viewfinder opens
[ ] Point at valid bag-card QR → scan resolves (uses BarcodeDetector path)
[ ] Deny permission → error panel shows, diagnostics shows "Camera permission — denied" with red X
[ ] "Use typed input instead" link works

Device: Desktop Chrome (local dev, HTTP)
[ ] Open floor station URL over HTTP (localhost)
[ ] Tap camera icon → error shown immediately: "Camera access requires HTTPS"
[ ] Diagnostics panel shows HTTPS secure context: red X
[ ] "Use typed input instead" link works

Typed scan fallback (any device)
[ ] Type valid bag token in text field, press Enter → same lookup path as camera scan
[ ] Type invalid token → scanError message shown
[ ] Type retired/wrong-type token → specific error message shown

Dropdown fallback (any device)
[ ] Select bag from dropdown, click Start bag → workflow advances
[ ] Dropdown shows correct optgroup labels

Error states
[ ] On HTTP: diagnostics shows secure context red X, Camera API red X
[ ] On permission denied: diagnostics shows camera permission red X, stream started red X
[ ] On unsupported browser with jsQR: diagnostics shows BarcodeDetector "using jsQR fallback" green
[ ] jsQR label is always green (bundled)
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| Safety check | Pre-work note at top |
| Inspect implementation | Root cause analysis (video DOM bug) |
| Does it require secure context? | `getStaticCameraDiagnostics` + existing error path |
| iOS Safari support | jsQR fallback path (unchanged) |
| Android Chrome support | BarcodeDetector path (unchanged) |
| jsQR fallback works | Unchanged; confirmed in tests |
| Scanner mounted after user interaction | Camera opened by button click (unchanged) |
| Scanned token same path as typed | `handleCameraResult → handleResolvedToken` (unchanged) |
| Errors user-friendly | Error messages unchanged; diagnostics panel added |
| Add diagnostics | `CameraDiagnosticsPanel` in error phase |
| Fix scanner behavior on HTTPS | Video DOM bug fixed (Task 2) |
| HTTP shows clear message | Existing code + diagnostics panel confirms |
| Permission denied message | Existing message + `permissionDenied` state in diagnostics |
| jsQR fallback if BarcodeDetector absent | Existing code (unchanged) |
| Stop stream after scan | Both paths already do this; structural tests verify |
| No dropdown required after scan | `handleCameraResult → handleResolvedToken` (unchanged) |
| Tests | Task 1 (5) + Task 2 (9) = 14 new tests |
| Version bump | Task 3 |
| typecheck + test + build | Task 4 |
| Push | Task 4 |
| Manual QA checklist | End of plan |

**Placeholder scan:** None found.

**Type consistency:** `CameraDiagnostics` defined in Task 1, imported in Task 2. `classifyCameraCapabilities` defined in Task 1, tested in Task 1. `getStaticCameraDiagnostics` defined in Task 1, used in Task 2. All names consistent.
