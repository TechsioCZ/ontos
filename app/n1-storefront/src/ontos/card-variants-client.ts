"use client";

import { Cache, Effect, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { CardVariantsApi, CardVariantsQuerySchema } from "./card-variants";
import type { CardVariantsQuery, CardVariantsResult } from "./card-variants";
import { clientRuntime } from "./client-runtime";

const api = HttpApiClient.make(CardVariantsApi);
/** The bounded cache coalesces hover/focus intent, never speculative listing requests. */
export const makeCardVariantsCache = () =>
  Cache.make({
    capacity: 32,
    lookup: (key: string) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(CardVariantsQuerySchema))(key).pipe(
        Effect.flatMap((query) =>
          api.pipe(Effect.flatMap((client) => client.cardVariants.read({ query }))),
        ),
        Effect.timeout("30 seconds"),
      ),
    requireServicesAt: "lookup",
    timeToLive: "1 minute",
  });
const cache = clientRuntime.runSync(makeCardVariantsCache());
export const loadCardVariants = (query: CardVariantsQuery) =>
  Cache.get(cache, JSON.stringify(query)).pipe(
    Effect.map((result): CardVariantsResult =>
      result.state === "ready" &&
      (result.productId !== query.productId || result.slug !== query.slug)
        ? { state: "unavailable" }
        : result,
    ),
  );
