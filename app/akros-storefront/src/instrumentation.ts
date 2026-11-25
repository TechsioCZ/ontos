export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [Effect, NodeFileSystem, { startStorefrontObservability }] = await Promise.all([
      import("effect/Effect"),
      import("@effect/platform-node/NodeFileSystem"),
      import("@ontos/storefront-runtime/observability"),
    ]);
    Effect.runFork(
      startStorefrontObservability(
        "akros-storefront",
        process.env.ONTOS_SOURCE_REVISION ?? "unknown",
      ).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.tapCause((cause) => Effect.logError("Storefront observability stopped", cause)),
      ),
    );
  }
};
