import type { ReactNode } from "react";
import type { CSSProperties } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata = {
  title: "Luma — Production Command",
  description: "Manufacturing intelligence for the production floor",
};

// LUMA-UI-REBUILD-1 — Geist Sans + Geist Mono loaded via next/font so
// the design tokens in globals.css can resolve --font-sans /
// --font-mono to the actually loaded font families. next/font
// self-hosts the files; no Google Fonts network dependency.

const fontVars: CSSProperties = {
  // Inline overrides on the html element so var() resolves correctly
  // for nested CSS that references --font-sans / --font-mono.
} as CSSProperties;
// Tailwind picks up the var via the className token bindings below.
Object.assign(fontVars, {
  ["--font-sans"]: GeistSans.style.fontFamily,
  ["--font-display"]: GeistSans.style.fontFamily,
  ["--font-mono"]: GeistMono.style.fontFamily,
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      style={fontVars}
    >
      <body className="bg-canvas text-text antialiased">{children}</body>
    </html>
  );
}
