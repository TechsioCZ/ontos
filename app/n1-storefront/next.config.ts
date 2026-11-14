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
};

export default config;
