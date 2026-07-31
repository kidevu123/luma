"use client";

import * as React from "react";
import * as QRCode from "qrcode";

// Absolute floor URL as a QR for kiosk-app provisioning (Fully Kiosk
// Browser, Guided Access, etc.). Origin comes from window.location so
// the code matches whatever host the admin is viewing — same pattern
// as CopyFloorUrl.

export function KioskQr({ token }: { token: string }) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const fullUrl = `${window.location.origin}/floor/${token}`;
    let cancelled = false;
    void QRCode.toDataURL(fullUrl, {
      margin: 1,
      width: 120,
      errorCorrectionLevel: "M",
    }).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex items-start gap-3 pt-1">
      <div className="shrink-0 rounded border border-border bg-white p-1.5">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL from qrcode; no Next Image optimizer needed
          <img
            src={dataUrl}
            alt="Floor station URL QR code"
            width={96}
            height={96}
            className="block h-24 w-24"
          />
        ) : (
          <div
            className="h-24 w-24 animate-pulse rounded bg-surface-2/60"
            aria-hidden
          />
        )}
      </div>
      <p className="text-[10px] text-text-subtle leading-relaxed max-w-[200px] pt-1">
        Scan with your kiosk app (Fully Kiosk Browser, etc.) and set this as
        the Start URL.
      </p>
    </div>
  );
}
