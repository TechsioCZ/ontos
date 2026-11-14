import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  experimental: { cpus: 1, webpackMemoryOptimizations: true },
  async headers() {
    return [
      {
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
        source: "/:path*",
      },
    ];
  },
  images: { unoptimized: true },
  output: "standalone",
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  reactStrictMode: true,
  // Types are proven by tsrs before this build: the workspace `pnpm typecheck` gate (the root
  // tsconfig.json references tsconfig.typecheck.json) and `pnpm typecheck` here. Next's
  // TypeScript 5.9 pass took 2.8 minutes of the Zerops build and checked the same files again.
  typescript: { ignoreBuildErrors: true },
};

export default config;
