// Flat ESLint config for the whole monorepo.
//
// - Base JS + TypeScript rules come from the recommended presets.
// - The Next.js app (`apps/web`) uses `eslint-config-next`'s flat config
//   (`eslint-config-next/core-web-vitals`), which in Next 16 is itself a flat
//   config array — so we spread it directly instead of shimming through
//   FlatCompat. (FlatCompat + ESLint 10 fails with a circular-JSON error.)
// - Prettier is applied last so it disables conflicting formatting rules.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // Ignores shared across every workspace.
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
      "**/out/**",
      "**/*.tsbuildinfo",
      "**/.llm-wiki/**",
      // Next.js-generated type file uses triple-slash references by design.
      "apps/web/next-env.d.ts",
      // Next.js-generated; not hand-written.
      "apps/web/.next/types/**",
    ],
  },

  // Base JS + TypeScript rules for the whole repo.
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // CLI package: Node environment, ESM.
  {
    files: ["packages/cli/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        node: true,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Web app: Next.js core-web-vitals flat config, scoped to apps/web.
  // eslint-config-next v16 ships a flat config array; we map each entry to
  // only apply under apps/web so the Next plugin's file globs stay local.
  ...nextCoreWebVitals.map((config) => ({
    ...config,
    files: ["apps/web/**/*.{ts,tsx,js,jsx}"],
  })),
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Prettier must be last so it disables conflicting formatting rules.
  prettierConfig,
);
