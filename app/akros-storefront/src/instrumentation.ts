let observing = false;

export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
