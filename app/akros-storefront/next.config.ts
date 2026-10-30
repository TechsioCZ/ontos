import { resolve } from "node:path";
import type { NextConfig } from "next";

// Extra https image hosts an OntOS admin may use (comma-separated). Must match the server env at build AND start;
// src/ontos/catalog-projection.ts replaces images from any other host with the honest placeholder.
const extraImageHosts = (process.env.STOREFRONT_IMAGE_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

// Zerops runs the storefront as a plain Node server from the self-contained standalone bundle
// (.next/standalone/akros-storefront/server.js). Like the Worker build, it serves image URLs as is.
const standalone = process.env.AKROS_STANDALONE_BUILD === "1";

const nextConfig: NextConfig = {
  agentRules: false,
  ...(standalone
    ? {
        output: "standalone" as const,
        // Build-only tooling the workspace hoists next to Next.js; the server never loads it.
        outputFileTracingExcludes: {
          "*": [
            "**/node_modules/.pnpm/{webpack,minimizer-webpack-plugin,cssnano*,postcss-*,clean-css,csso,css-tree,html-minifier-terser,terser,svgo,sass,lightningcss*,esbuild,@esbuild+*,@swc+core*,sharp,@img+*}@*/**",
          ],
        },
      }
    : {}),
  // Preserve loopback IP origins so the exact-origin request guard matches the browser.
  skipProxyUrlNormalize: true,
  // pnpm resolves dependencies through the workspace virtual store above this app.
  outputFileTracingRoot: resolve(process.cwd(), ".."),
  images: {
    unoptimized: process.env.AKROS_CLOUDFLARE_BUILD === "1" || standalone,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.akros.cz",
        pathname: "/data/**",
      },
      ...extraImageHosts.map((hostname) => ({
        protocol: "https" as const,
        hostname,
        pathname: "/**",
      })),
    ],
  },
  reactStrictMode: true,
  // Catalog responses already have a strict ten-second owner-read window. Never extend it in the router.
  experimental: { staleTimes: { static: 0, dynamic: 0 } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/nerezovy-spojovaci-material",
        destination: "/kategorie/nerezovy-spojovaci-material",
      },
      { source: "/srouby", destination: "/kategorie/srouby" },
      { source: "/matice", destination: "/kategorie/matice" },
      { source: "/podlozky", destination: "/kategorie/podlozky" },
      { source: "/zavitove-tyce", destination: "/kategorie/zavitove-tyce-a-svorniky" },
      { source: "/kotevni-technika", destination: "/kategorie/kotevni-technikalepidla" },
      { source: "/retezy-a-lana", destination: "/kategorie/lanaretezypantyjachtdopln" },
      { source: "/sady-a-sortimenty", destination: "/kategorie/sady-a-sortimenty" },
      { source: "/naradi-a-prislusenstvi", destination: "/kategorie/naradi-a-prislusenstvi" },
      {
        source: "/srouby-se-sestihrannou-hlavou-din-933-a2",
        destination: "/produkt/srouby-se-sestihrannou-hlavou-din-933-a2",
      },
      {
        source: "/produkt/vrut-univerzalni-se-zapustnou-hlavou",
        destination: "/produkt/vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2",
      },
      {
        source: "/matice-sestihranna-m8-din-934-a2",
        destination: "/produkt/matice-sestihranne-0-8-d-din-934-a2?variant=10093400080000",
      },
    ];
  },
};

export default nextConfig;
