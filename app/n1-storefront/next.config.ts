import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
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
  // Kept out of the standalone server. The server never loads build-only tooling (same list as the
  // AKROS storefront, plus the type checkers and the test runner), and webpack compiles every
  // @app/* module N1 imports into .next/server, so workspace sources are never read at runtime.
  // Native binaries (@next/swc, sharp) also stay out: the runner builds on glibc, Zerops runs musl.
  outputFileTracingExcludes: {
    "*": [
      "**/node_modules/.pnpm/{webpack,minimizer-webpack-plugin,cssnano*,postcss-*,clean-css,csso,css-tree,html-minifier-terser,terser,svgo,sass,lightningcss*,esbuild,@esbuild+*,@swc+core*,@next+swc-*,sharp,@img+*,typescript,@typescript+*,tsrs,@tsrs+*,@effect+tsgo*,tailwindcss,@tailwindcss+*,@rstest+*,oxlint*,@oxlint+*,oxfmt*}@*/**",
      "{apps,verticals,packages}/*/{src,shared,server,api,scripts,tests,locales}/**",
    ],
  },
  // pnpm resolves dependencies through the workspace virtual store above this app.
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),
  reactStrictMode: true,
};

export default config;
