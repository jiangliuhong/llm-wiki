import type { NextConfig } from "next";

/**
 * Next.js config for the LLLM Wiki web app.
 *
 * - `transpilePackages` is required for HeroUI v3 (per the official Next.js +
 *   HeroUI guide) so its ESM packages are transpiled to a form Next can bundle.
 * - `serverExternalPackages` keeps native Node addons (`better-sqlite3`,
 *   `sqlite-vec`) out of the bundler: Next must `require()` them at runtime
 *   rather than try to bundle their `.node` binaries.
 *
 * Note: Next.js 16 removed the `next lint` command and its built-in lint step,
 * so there is no `eslint` config key here. Linting is run explicitly via
 * `pnpm lint` (flat ESLint config), which covers the web app correctly.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@heroui/react"],
  serverExternalPackages: ["better-sqlite3", "sqlite-vec"],
};

export default nextConfig;
