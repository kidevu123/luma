// CLEANUP-PHASE-0-LINT — minimal ESLint flat config so `npm run lint`
// runs non-interactively in CI. Mirrors tsconfig.json's exclude list
// (scripts/, luma-*, .next, drizzle, node_modules) so we lint only
// the production source. Uses @typescript-eslint/parser for TS files
// and @next/eslint-plugin-next's "recommended" rules — strict enough
// to catch real bugs, lax enough not to drown Phase 0 in noise.
//
// Intentionally minimal: @typescript-eslint plugin is REGISTERED so
// inline `// eslint-disable-next-line @typescript-eslint/<rule>`
// directives resolve, but NONE of its rules are enabled. A follow-up
// phase can layer them in.

import nextPlugin from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "drizzle/**",
      "luma-*/**",
      "scripts/_*.ts",
      "scripts/_*.tsx",
      "scripts/_*.mjs",
      "scripts/_*.js",
      "**/*.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    files: ["**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
];
