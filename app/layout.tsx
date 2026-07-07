import type { ReactNode, CSSProperties } from "react";
import type { Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Fraunces } from "next/font/google";
import "./globals.css";

// LUMA-UI-REBUILD-1 v2 — Operations Atelier type stack.
//
// - Geist Sans (body / UI) — self-hosted via next/font/geist
// - Geist Mono (code / IDs) — self-hosted via next/font/geist
// - Fraunces (display) — modern high-contrast serif, self-hosted at
//   build via next/font/google. Used for hero numerals + display
//   titles. Variable axes available: opsz (auto optical sizing),
//   SOFT, WONK. CSS picks them up via font-variation-settings.

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

export const metadata = {
  // PAGE-TITLES-1 — pages set their own title (e.g. "PO Closeout") and the
  // template renders it as "Luma — PO Closeout"; pages without their own
  // metadata keep the default.
  title: {
    default: "Luma — Production Command",
    template: "Luma — %s",
  },
  description: "Manufacturing intelligence for the production floor",
};

// viewport-fit=cover lets the floor PWA use the full screen on notched
// iPhones (Face ID models) without white bars. interactiveWidget keeps
// the layout stable when the software keyboard appears.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-visual",
};

const fontVars: CSSProperties = {} as CSSProperties;
Object.assign(fontVars, {
  ["--font-sans"]: GeistSans.style.fontFamily,
  ["--font-mono"]: GeistMono.style.fontFamily,
  // --font-display is set by the Fraunces variable below.
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${fraunces.variable}`}
      style={fontVars}
    >
      <body className="bg-canvas text-text antialiased">{children}</body>
    </html>
  );
}
