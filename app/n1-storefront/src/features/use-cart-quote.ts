"use client";

import { useEffect, useState } from "react";
import { Effect, Fiber, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { CartQuoteApi, CartQuoteRequestSchema } from "@/ontos/cart-quote";
import type { CartQuote, CartQuoteRequest } from "@/ontos/cart-quote";
import { clientRuntime } from "@/ontos/client-runtime";
import {
  advanceQuoteSelection,
  isCurrentQuoteSnapshot,
  quoteFailureState,
} from "./cart-quote-state";

const quoteClient = HttpApiClient.make(CartQuoteApi);
/** Consumer chooses an explicit first check or automatic checks while its panel is open. */
export const useCartQuote = (input: CartQuoteRequest | null, automatic = false) => {
  const key = input === null ? null : JSON.stringify(input);
  const [attempt, setAttempt] = useState(automatic ? 1 : 0);
  const [previousSelection, setPreviousSelection] = useState({ generation: 0, key });
  const selection = advanceQuoteSelection(previousSelection, key);
  if (selection !== previousSelection) {
    setPreviousSelection(selection);
  }
  const { generation } = selection;
  const [snapshot, setSnapshot] = useState<{
    attempt: number;
    failure: "scope-mismatch" | "unavailable" | null;
    generation: number;
    key: string;
    result: CartQuote | null;
  } | null>(null);
  useEffect(() => {
    const program =
      key === null
        ? Effect.void
        : Schema.decodeUnknownEffect(Schema.fromJsonString(CartQuoteRequestSchema))(key).pipe(
            Effect.flatMap((payload) =>
              quoteClient.pipe(Effect.flatMap((api) => api.cartQuote.quote({ payload }))),
            ),
            Effect.timeout("45 seconds"),
            Effect.match({
              onFailure: (error) =>
                setSnapshot({
                  attempt,
                  failure: quoteFailureState(error),
                  generation,
                  key,
                  result: null,
                }),
              onSuccess: (result) =>
                setSnapshot({ attempt, failure: null, generation, key, result }),
            }),
          );
    const fiber = clientRuntime.runFork(attempt === 0 ? Effect.void : program);
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [attempt, generation, key]);
  const current = isCurrentQuoteSnapshot(snapshot, selection, attempt);
  let state: "idle" | "pending" | "unavailable" | "scope-mismatch" | "ready" = "idle";
  if (key !== null && attempt > 0) {
    state = current ? "ready" : "pending";
    if (current && snapshot?.result === null) {
      state = snapshot.failure ?? "unavailable";
    }
  }
  return {
    result: current ? (snapshot?.result ?? null) : null,
    state,
    verify: () => setAttempt((value) => value + 1),
  };
};
