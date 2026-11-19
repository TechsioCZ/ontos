import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { loadBindings, transform } from "next/dist/build/swc";
import type { generateMetadata } from "@/app/storefront-metadata";

/**
 * Load the layout's real named export using Next's font compiler. Plain Vite
 * cannot execute next/font's compile-time call. Tree shaking omits the unused
 * layout and CSS, not its metadata binding or any metadata implementation.
 */
export async function loadLayoutMetadata(): Promise<typeof generateMetadata> {
  const require = createRequire(import.meta.url);
  const layout = fileURLToPath(new NodeURL("../../src/app/layout.tsx", import.meta.url));
  await loadBindings();
  const result = await build({
    stdin: {
      contents: `export { generateMetadata } from ${JSON.stringify(layout)}`,
      resolveDir: dirname(layout),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    plugins: [
      {
        name: "next-layout-metadata",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
            // Only the named metadata export is executed. The layout's other
            // imports belong to the unused default export, not this entrypoint.
            if (importer === layout && path !== "./storefront-metadata")
              return { path, external: true, sideEffects: false };
          });
          builder.onLoad({ filter: /[/\\]src[/\\]app[/\\]layout\.tsx$/ }, async ({ path }) => {
            const compiled: { code: string } = await transform(await readFile(path, "utf8"), {
              filename: path,
              jsc: { parser: { syntax: "typescript", tsx: true } },
              fontLoaders: {
                fontLoaders: ["next/font/local"],
                relativeFilePathFromRoot: "src/app/layout.tsx",
              },
            });
            return { contents: compiled.code, loader: "js", resolveDir: dirname(path) };
          });
          builder.onResolve({ filter: /\.css(?:\?|$)/ }, ({ path }) => ({
            path,
            external: true,
            sideEffects: false,
          }));
          builder.onResolve({ filter: /^[^./]/ }, ({ path }) => {
            if (path.startsWith("@/")) return;
            return {
              path: path.startsWith("node:")
                ? path
                : pathToFileURL(
                    require.resolve(
                      path === "server-only" ? "next/dist/compiled/server-only/empty.js" : path,
                    ),
                  ).href,
              external: true,
            };
          });
        },
      },
    ],
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("Next layout compilation produced no module");
  const layoutExports: unknown = await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
  );
  if (
    typeof layoutExports !== "object" ||
    layoutExports === null ||
    !("generateMetadata" in layoutExports) ||
    typeof layoutExports.generateMetadata !== "function"
  )
    throw new Error("The root layout must export generateMetadata");
  return layoutExports.generateMetadata as typeof generateMetadata;
}
