import { markLandingAnswered } from "./ontos/readiness.ts";

let observing = false;

// Shared owner reads are served stale for at most 10 minutes (shared-read.ts). One request to the landing page every
// few minutes keeps the market directory, the category tree and the featured products inside that window, so the first
// shopper after a deploy or a quiet spell gets a warm answer instead of a chain of blocking owner reads. A header search
// right after it reads the shared ERP snapshot (erp-catalogue-server.ts) before the first shopper searches and keeps it
// read in the background, so the first search after a deploy or a quiet spell finds the ERP products too. A new
// container takes traffic only once the first visit was answered (src/app/api/ontos/ready/route.ts).
const WARM_EVERY_MS = 4 * 60_000;
let warming = false;
const warmLanding = () => {
  if (warming) return;
  warming = true;
  const origin = `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const agent = "ontos-akros-storefront-warmup";
  const visit = async () => {
    try {
      const landing = await fetch(`${origin}/cs`, {
        cache: "no-store",
        headers: { "user-agent": agent },
        signal: AbortSignal.timeout(30_000),
      });
      await landing.arrayBuffer();
      // Any answer: the process has rendered its landing once (an owner outage must not hold a deploy).
      markLandingAnswered();
      if (!landing.ok) return false;
      const search = await fetch(`${origin}/api/ontos/search`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "user-agent": agent,
          "content-type": "application/json",
          "x-akros-market-locale": "cs",
        },
        body: JSON.stringify({ q: "vrut" }),
        signal: AbortSignal.timeout(30_000),
      });
      await search.arrayBuffer();
      return search.ok;
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
    const [Effect, NodeFileSystem, { startStorefrontObservability }, { observeShellConnections }] =
      await Promise.all([
        import("effect/Effect"),
        import("@effect/platform-node/NodeFileSystem"),
        import("@ontos/storefront-runtime/observability"),
        import("./ontos/connection-diagnostics.ts"),
      ]);
    if (observing) return;
    observing = true;
    Effect.runFork(
      Effect.acquireUseRelease(
        Effect.sync(() => observeShellConnections(process.env.ONTOS_SHELL_URL)),
        () =>
          startStorefrontObservability(
            "akros-storefront",
            process.env.ONTOS_SOURCE_REVISION ?? "unknown",
          ),
        (stop) => Effect.sync(stop),
      ).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.ensuring(
          Effect.sync(() => {
            observing = false;
          }),
        ),
        Effect.tapCause((cause) => Effect.logError("Storefront observability stopped", cause)),
      ),
    );
  }
};
