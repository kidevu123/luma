import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Luma",
  description: "Production-floor traceability",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-page text-text antialiased">{children}</body>
    </html>
  );
}
