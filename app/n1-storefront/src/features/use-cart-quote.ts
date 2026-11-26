"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
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
import type { CartQuoteFeedbackState } from "./cart-quote-state";

const quoteClient = HttpApiClient.make(CartQuoteApi);
const quoteReuseMs = 30_000;

interface CartQuoteView extends CartQuoteFeedbackState {
  stocks: NonNullable<CartQuote["stocks"]>;
  verify: () => void;
}

interface QuoteSnapshot {
  attempt: number;
  checkedAt: number;
  failure: "scope-mismatch" | "unavailable" | null;
  generation: number;
  key: string;
  result: CartQuote | null;
}
interface QuoteConsumers {
  active: number;
  openedAt: number;
}
const needsFreshQuote = (snapshot: QuoteSnapshot | null, openedAt: number) =>
  snapshot !== null &&
  (snapshot.failure === "unavailable"
    ? openedAt > snapshot.checkedAt
    : snapshot.result !== null && openedAt - snapshot.checkedAt >= quoteReuseMs);

const quoteState = (
  key: string | null,
  snapshot: QuoteSnapshot | null,
): CartQuoteFeedbackState["state"] => {
  if (key === null) {
    return "idle";
  }
  if (snapshot === null) {
    return "pending";
  }
  return snapshot.failure ?? "ready";
};

/** The scoped cart owns one verification for the current saved selection. */
export const useCartQuoteRequest = (input: CartQuoteRequest | null) => {
  const [consumers, setConsumers] = useState<QuoteConsumers>({ active: 0, openedAt: 0 });
  const key = input === null ? null : JSON.stringify(input);
  const scopeKey = input === null ? null : JSON.stringify(input.scope);
  const [stockSnapshot, setStockSnapshot] = useState<{
    scopeKey: string;
    stocks: NonNullable<CartQuote["stocks"]>;
  } | null>(null);
  const [check, setCheck] = useState({ attempt: 0, generation: -1 });
  const [previousSelection, setPreviousSelection] = useState({ generation: 0, key });
  const selection = advanceQuoteSelection(previousSelection, key);
  if (selection !== previousSelection) {
    setPreviousSelection(selection);
  }
  const { generation } = selection;
  const { attempt } = check;
  const requested = check.generation === generation;
  const [snapshot, setSnapshot] = useState<QuoteSnapshot | null>(null);
  // A background attempt must not erase confirmed prices for this exact selection generation.
  const displayed =
    requested && snapshot?.key === selection.key && snapshot.generation === generation
      ? snapshot
      : null;
  const current =
    requested && isCurrentQuoteSnapshot(snapshot, selection, attempt) ? snapshot : null;
  // Recheck on demand when a viewer opens the cart, without polling a cart already open.
  const refreshOnOpen = needsFreshQuote(current, consumers.openedAt);
  if (key !== null && (!requested || (consumers.active > 0 && refreshOnOpen))) {
    setCheck({ attempt: attempt + 1, generation });
  }
  const activeKey = requested ? key : null;
  useEffect(() => {
    const fiber =
      activeKey === null
        ? null
        : clientRuntime.runFork(
            Schema.decodeUnknownEffect(Schema.fromJsonString(CartQuoteRequestSchema))(
              activeKey,
            ).pipe(
              // Coalesce quick quantity changes before warming the shared quote.
              Effect.delay("200 millis"),
              Effect.flatMap((payload) =>
                quoteClient.pipe(Effect.flatMap((api) => api.cartQuote.quote({ payload }))),
              ),
              Effect.timeout("45 seconds"),
              Effect.match({
                onFailure: (error) =>
                  setSnapshot({
                    attempt,
                    checkedAt: performance.now(),
                    failure: quoteFailureState(error),
                    generation,
                    key: activeKey,
                    result: null,
                  }),
                onSuccess: (result) => {
                  setSnapshot({
                    attempt,
                    checkedAt: performance.now(),
                    failure: null,
                    generation,
                    key: activeKey,
                    result,
                  });
                  if (result.stocks !== undefined) {
                    setStockSnapshot({
                      scopeKey: JSON.stringify(result.scope),
                      stocks: result.stocks,
                    });
                  }
                },
              }),
            ),
          );
    return () => {
      if (fiber !== null) {
        clientRuntime.runFork(Fiber.interrupt(fiber));
      }
    };
  }, [activeKey, attempt, generation]);
  const verify = () => setCheck((previous) => ({ attempt: previous.attempt + 1, generation }));
  const quote: CartQuoteView = {
    result: displayed?.result ?? null,
    state: quoteState(activeKey, current),
    stocks: stockSnapshot?.scopeKey === scopeKey ? stockSnapshot.stocks : [],
    verify,
  };
  return { quote, setConsumers };
};
const idleQuote: CartQuoteView = {
  result: null,
  state: "idle",
  stocks: [],
  verify: () => {
    // A cart without a provider has no selection to verify.
  },
};

export const CartQuoteContext = createContext<{
  quote: CartQuoteView;
  setConsumers: Dispatch<SetStateAction<QuoteConsumers>>;
} | null>(null);

export const useCartQuote = (visible = true): CartQuoteView => {
  const shared = useContext(CartQuoteContext);
  const setConsumers = shared?.setConsumers;
  useEffect(() => {
    if (visible) {
      const openedAt = performance.now();
      setConsumers?.(({ active }) => ({ active: active + 1, openedAt }));
    }
    return () => {
      if (visible) {
        setConsumers?.((previous) => ({ ...previous, active: previous.active - 1 }));
      }
    };
  }, [visible, setConsumers]);
  return shared?.quote ?? idleQuote;
};
