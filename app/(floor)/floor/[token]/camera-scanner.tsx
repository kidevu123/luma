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

import * as React from "react";
import { X, CameraOff, Loader2 } from "lucide-react";
import jsQR from "jsqr";

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

  React.useEffect(() => {
    let mounted = true;

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (mounted) {
          setErrorMsg(
            "Camera API not available in this browser. Use the text input below instead.",
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
      // jsQR fallback path (existing code below — DO NOT MODIFY)
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
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-brand-700 underline"
            >
              Use typed input instead
            </button>
          </div>
        )}

        {phase === "scanning" && (
          <>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              ref={videoRef}
              muted
              playsInline
              className="w-full aspect-square object-cover bg-black"
            />
            <p className="text-center text-xs text-text-muted py-3 px-4">
              Point camera at the bag QR label
            </p>
          </>
        )}

        <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
      </div>
    </div>
  );
}
