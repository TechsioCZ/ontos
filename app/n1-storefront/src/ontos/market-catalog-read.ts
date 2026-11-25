import { storefrontRuntime } from "./runtime";
import { hasRenderLifetime, renderOperation } from "./render-operation";
import "server-only";
import { cache } from "react";
import { Clock, Effect } from "effect";
import { createOperation, deadlineAfter, OPERATION_TIMEOUT_MS } from "@ontos/storefront-runtime";
import type { Operation, OperationDeadline, OperationOptions } from "@ontos/storefront-runtime";
import type { StorefrontConfiguration } from "./config";
import { readOwner } from "./gateway";
import { MarketCatalogSchema } from "./market";
import { CurrentOperation, withOwnerOperation } from "./owner-operation";

const readMarketCatalog = (
  config: StorefrontConfiguration,
  options: OperationOptions,
  deadline: OperationDeadline,
) =>
  Effect.acquireUseRelease(
    // The shared read owns its lifetime, not the CurrentOperation inherited from its first waiter.
    createOperation({
      deadline,
      parent: options.operation,
      signal: AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        ...(options.operation ? [options.operation.signal] : []),
      ]),
    }),
    (operation) =>
      Effect.gen(function* readMarketCatalogProgram() {
        const now = yield* Clock.currentTimeMillis;
        const markets = yield* readOwner(
          config,
          "commerce-market-catalog",
          "current-market-catalog",
          { at: new Date(now).toISOString() },
          MarketCatalogSchema,
          { operation },
        );
        return { markets, now };
      }).pipe(Effect.updateService(CurrentOperation, () => operation)),
    (operation) =>
      Effect.sync(() => {
        operation.dispose();
      }),
  );

type SharedMarketCatalogRead = ReturnType<typeof readMarketCatalog>;

/** Allocation fixes the monotonic budget; Effect.cached owns and interrupts the shared source. */
export const createMarketCatalogRead = (options: OperationOptions = {}) =>
  Effect.gen(function* allocateMarketCatalogRead() {
    const deadline = options.operation?.deadline ?? (yield* deadlineAfter(OPERATION_TIMEOUT_MS));
    const reads = new Map<string, SharedMarketCatalogRead>();
    return (config: StorefrontConfiguration) =>
      withOwnerOperation(
        Effect.gen(function* subscribeMarketCatalog() {
          const key = JSON.stringify([config.shellUrl, config.apiKey, config.legalEntityId]);
          let read = reads.get(key);
          if (read === undefined) {
            read = yield* Effect.cached(readMarketCatalog(config, options, deadline));
            reads.set(key, read);
          }
          return yield* read;
        }),
        options,
      );
  });

// React must retain the acquired holder, not a lazy Effect that allocates afresh on each execution.
const requestReads = cache(async () => {
  const operation = await renderOperation();
  return await storefrontRuntime.runPromise(createMarketCatalogRead({ operation }));
});
type MarketCatalogRead = Effect.Success<ReturnType<typeof createMarketCatalogRead>>;
const operationReads = new WeakMap<Operation, MarketCatalogRead>();

/** An App Route's explicit CurrentOperation always wins over Next's render stores. */
export const readCurrentMarketCatalog = (config: StorefrontConfiguration) =>
  Effect.gen(function* currentMarketCatalog() {
    const operation = yield* CurrentOperation;
    if (operation !== undefined) {
      let read = operationReads.get(operation);
      if (read === undefined) {
        read = yield* createMarketCatalogRead({ operation });
        operationReads.set(operation, read);
      }
      return yield* read(config);
    }
    const read = hasRenderLifetime()
      ? yield* Effect.promise(async () => await requestReads())
      : yield* createMarketCatalogRead();
    return yield* read(config);
  });
