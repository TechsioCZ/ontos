import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  experimental: {
    // Compile only the core-runtime modules N1's platform contracts use. Without this, the root and enforcement
    // barrels pull the SpiceDB/gRPC client and about 600 other server-only modules into the server build.
    optimizePackageImports: ["@app/core-runtime", "@app/core-runtime/access/enforcement"],
  },
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
  // Build-only tooling the workspace hoists next to Next.js; the server never loads it.
  outputFileTracingExcludes: {
    "*": [
      "**/node_modules/.pnpm/{webpack,minimizer-webpack-plugin,cssnano*,postcss-*,clean-css,csso,css-tree,html-minifier-terser,terser,svgo,sass,lightningcss*,esbuild,@esbuild+*,@swc+core*,sharp,@img+*}@*/**",
    ],
  },
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  reactStrictMode: true,
  // `pnpm --filter n1-storefront typecheck` checks the types in CI; the build only compiles.
  typescript: { ignoreBuildErrors: true },
};

export default config;
