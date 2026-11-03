import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  output: "standalone",
  outputFileTracingRoot: resolve(process.cwd(), ".."),
  reactStrictMode: true,
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
    ];
  },
};

export default config;
