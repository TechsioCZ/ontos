// Shared public reads are served stale for at most 10 minutes (ontos/shared-read.ts). One request to the landing page
// every few minutes keeps the cart scope, the category tree and the featured products inside that window, so the first
// shopper after a deploy or a quiet spell gets a warm answer instead of a chain of blocking owner reads.
const WARM_EVERY_MS = 4 * 60_000;
let warming = false;
const warmLanding = () => {
  if (warming) return;
  warming = true;
  const landing = `http://127.0.0.1:${process.env.PORT ?? "3000"}/cs`;
  const visit = async () => {
    try {
      const response = await fetch(landing, {
        cache: "no-store",
        headers: { "user-agent": "ontos-n1-storefront-warmup" },
        signal: AbortSignal.timeout(30_000),
      });
      await response.arrayBuffer();
      return response.ok;
    } catch {
      return false;
    }
  };
  // The server starts listening after register(): retry until the first visit is answered.
  const first = async (attempt: number) => {
    if ((await visit()) || attempt >= 24) return;
    setTimeout(() => void first(attempt + 1), 5_000).unref();
  };
  setTimeout(() => void first(0), 2_000).unref();
  setInterval(() => void visit(), WARM_EVERY_MS).unref();
};

export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    warmLanding();
    const [Effect, NodeFileSystem, { startStorefrontObservability }] = await Promise.all([
      import("effect/Effect"),
      import("@effect/platform-node/NodeFileSystem"),
      import("@ontos/storefront-runtime/observability"),
    ]);
    Effect.runFork(
      startStorefrontObservability(
        "n1-storefront",
        process.env.ONTOS_SOURCE_REVISION ?? "unknown",
      ).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.tapCause((cause) => Effect.logError("Storefront observability stopped", cause)),
      ),
    );
  }
};
