import type { Config } from "tailwindcss";

// LUMA-UI-REBUILD-1 — extends the existing token system with the
// industrial-command-surface palette + display/mono font families.
// Every color references a CSS variable from globals.css; never
// hardcode hex values in components.

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Canvas + surfaces
        page: "rgb(var(--bg-canvas) / <alpha-value>)",
        canvas: "rgb(var(--bg-canvas) / <alpha-value>)",
        surface: "rgb(var(--bg-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--bg-surface-2) / <alpha-value>)",
        "surface-3": "rgb(var(--bg-surface-3) / <alpha-value>)",
        inverse: "rgb(var(--bg-inverse) / <alpha-value>)",
        // Text
        text: "rgb(var(--text) / <alpha-value>)",
        "text-strong": "rgb(var(--text-strong) / <alpha-value>)",
        "text-muted": "rgb(var(--text-muted) / <alpha-value>)",
        "text-subtle": "rgb(var(--text-subtle) / <alpha-value>)",
        "text-inverse": "rgb(var(--text-on-inverse) / <alpha-value>)",
        // Hairlines
        border: "rgb(var(--border) / <alpha-value>)",
        "border-strong": "rgb(var(--border-strong) / <alpha-value>)",
        "border-inverse": "rgb(var(--border-inverse) / <alpha-value>)",
        // Brand teal
        brand: {
          50:  "rgb(var(--brand-50)  / <alpha-value>)",
          100: "rgb(var(--brand-100) / <alpha-value>)",
          200: "rgb(var(--brand-200) / <alpha-value>)",
          500: "rgb(var(--brand-500) / <alpha-value>)",
          600: "rgb(var(--brand-600) / <alpha-value>)",
          700: "rgb(var(--brand-700) / <alpha-value>)",
          800: "rgb(var(--brand-800) / <alpha-value>)",
          900: "rgb(var(--brand-900) / <alpha-value>)",
          accent: "rgb(var(--brand-accent) / <alpha-value>)",
        },
        // Status tones (semantic, never decorative)
        good: {
          50:  "rgb(var(--good-50)  / <alpha-value>)",
          500: "rgb(var(--good-500) / <alpha-value>)",
          700: "rgb(var(--good-700) / <alpha-value>)",
        },
        warn: {
          50:  "rgb(var(--warn-50)  / <alpha-value>)",
          500: "rgb(var(--warn-500) / <alpha-value>)",
          700: "rgb(var(--warn-700) / <alpha-value>)",
        },
        crit: {
          50:  "rgb(var(--crit-50)  / <alpha-value>)",
          500: "rgb(var(--crit-500) / <alpha-value>)",
          700: "rgb(var(--crit-700) / <alpha-value>)",
        },
        info: {
          50:  "rgb(var(--info-50)  / <alpha-value>)",
          500: "rgb(var(--info-500) / <alpha-value>)",
          700: "rgb(var(--info-700) / <alpha-value>)",
        },
        muted: {
          50:  "rgb(var(--muted-50)  / <alpha-value>)",
          500: "rgb(var(--muted-500) / <alpha-value>)",
          700: "rgb(var(--muted-700) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        display: ["var(--font-display)"],
        mono: ["var(--font-mono)"],
      },
      letterSpacing: {
        tightest: "-0.025em",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
        rail: "var(--shadow-rail)",
      },
      borderRadius: {
        xl: "12px",
        lg: "10px",
      },
    },
  },
  plugins: [],
} satisfies Config;
