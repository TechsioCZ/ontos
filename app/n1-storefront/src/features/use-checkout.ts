"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Effect, Match, Result, Schema } from "effect";
import { HttpApiClient } from "effect/http-api";
import { CheckoutApi, CheckoutRequestSchema } from "@/ontos/checkout";
import type { CheckoutResult } from "@/ontos/checkout";
import type { CheckoutOptions } from "@/ontos/checkout-server";
import type { CartQuoteRequest, CartScope } from "@/ontos/cart-quote";
import { clientRuntime } from "@/ontos/client-runtime";
import { useCart } from "./cart-provider";
import {
  cartLineSnapshot,
  checkoutGuardKey,
  readCheckoutGuard,
  removeCheckoutGuard,
  sameCheckoutLines,
  saveCheckoutGuard,
  withCheckoutLock,
} from "./checkout-guard";
import type { CheckoutGuard } from "./checkout-guard";
import type { CartEntry } from "./cart-state";
import { advanceQuoteSelection } from "./cart-quote-state";
import type { QuoteSelection } from "./cart-quote-state";
import { usePortalAuth } from "./auth-view";
import { observeCheckoutSession } from "./checkout-session-observation";

type ReadyOptions = Extract<CheckoutOptions, { state: "ready" }>;
type Notice =
  | "invalid"
  | "forbidden"
  | "scope-mismatch"
  | "unavailable"
  | "uncertain"
  | "storage"
  | "cart-preserved";
const checkoutClient = HttpApiClient.make(CheckoutApi);
class CheckoutDraftFailure extends Schema.TaggedError<CheckoutDraftFailure>()(
  "CheckoutDraftFailure",
  { reason: Schema.Literals(["invalid", "storage"]) },
) {}
const sendCheckout = (payload: typeof CheckoutRequestSchema.Type) =>
  checkoutClient.pipe(
    Effect.flatMap((api) => api.checkout.execute({ payload })),
    Effect.timeout("65 seconds"),
  );
const definitiveRefusal = (error: Effect.Error<ReturnType<typeof sendCheckout>>) =>
  Match.value(error).pipe(
    Match.tag(
      "CheckoutInvalidProblem",
      "CheckoutForbiddenProblem",
      "CheckoutScopeProblem",
      "CheckoutUnavailableProblem",
      () => true,
    ),
    Match.orElse(() => false),
  );

/** IO and generators live outside React Compiler's hook bodies. */
export const submitCheckoutProgram = ({
  fields,
  isCurrentSession,
  lines,
  locale,
  method,
  placing,
  scope,
}: {
  fields: FormData;
  isCurrentSession: () => boolean;
  lines: CartQuoteRequest["lines"];
  locale: string;
  method: ReadyOptions["shippingMethods"][number];
  placing: boolean;
  scope: CartScope;
}) =>
  Effect.gen(function* submitGuestCheckout() {
    const clientRequestId = yield* Effect.try({
      catch: () => new CheckoutDraftFailure({ reason: "storage" }),
      try: () => crypto.randomUUID(),
    });
    const request = yield* Schema.decodeUnknownEffect(CheckoutRequestSchema, {
      onExcessProperty: "error",
    })({
      address: {
        city: fields.get("city"),
        country: fields.get("country"),
        postalCode: fields.get("postalCode"),
        street: fields.get("street"),
      },
      clientRequestId,
      contact: {
        email: fields.get("email"),
        firstName: fields.get("firstName"),
        lastName: fields.get("lastName"),
        phone: fields.get("phone"),
      },
      expectedShippingPriceMinor: method.priceMinor,
      lines,
      locale,
      mode: placing ? "place" : "quote",
      scope,
      shippingMethod: method.id,
    }).pipe(Effect.mapError(() => new CheckoutDraftFailure({ reason: "invalid" })));
    const guard: CheckoutGuard = {
      clientRequestId,
      lines: request.lines,
      scope: request.scope,
      version: 1,
    };
    const send = sendCheckout(request);
    if (!placing) {
      return { guard, result: yield* send };
    }
    const result = yield* withCheckoutLock(
      scope,
      Effect.gen(function* guardedPlacement() {
        yield* saveCheckoutGuard(guard);
        const outcome = yield* Effect.result(send);
        if (Result.isFailure(outcome)) {
          if (isCurrentSession() && definitiveRefusal(outcome.failure)) {
            yield* removeCheckoutGuard(guard);
          }
          return yield* Effect.fail(outcome.failure);
        }
        if (isCurrentSession() && outcome.success.outcome === "REJECTED") {
          yield* removeCheckoutGuard(guard);
        }
        return outcome.success;
      }),
    );
    return { guard, result };
  });
const recoverCheckoutProgram = (guard: CheckoutGuard, locale: string) =>
  withCheckoutLock(
    guard.scope,
    checkoutClient.pipe(
      Effect.flatMap((api) =>
        api.checkout.status({
          payload: {
            clientRequestId: guard.clientRequestId,
            locale: locale === "en" ? "en" : "cs",
            scope: guard.scope,
          },
        }),
      ),
      Effect.timeout("65 seconds"),
    ),
  );

/** Restore only the still-current persisted intent; this program never creates or dismisses an order. */
export const recoverStoredCheckoutProgram = ({
  guard,
  isCurrent,
  locale,
  onConfirmed,
  onUnavailable,
}: {
  guard: CheckoutGuard;
  isCurrent: () => boolean;
  locale: string;
  onConfirmed: (result: CheckoutResult) => void;
  onUnavailable: () => void;
}) =>
  Effect.suspend(() => {
    if (!isCurrent()) {
      return Effect.void;
    }
    return recoverCheckoutProgram(guard, locale).pipe(
      Effect.flatMap((recovered) =>
        readCheckoutGuard(guard.scope).pipe(Effect.map((stored) => ({ recovered, stored }))),
      ),
      Effect.match({
        onFailure: () => {
          if (isCurrent()) {
            onUnavailable();
          }
        },
        onSuccess: ({ recovered, stored }) => {
          if (!isCurrent()) {
            return;
          }
          if (
            stored !== null &&
            stored.clientRequestId === guard.clientRequestId &&
            sameCheckoutLines(stored.lines, guard.lines) &&
            recovered.state === "confirmed" &&
            checkoutGuardKey(recovered.result.scope) === checkoutGuardKey(guard.scope)
          ) {
            onConfirmed(recovered.result);
          } else {
            onUnavailable();
          }
        },
      }),
    );
  });

/** Enrich an acknowledged placement once; a failed read never changes its committed outcome. */
export const recoverConfirmedCheckoutProgram = ({
  expected,
  guard,
  isCurrent,
  locale,
  onConfirmed,
  onUnavailable,
}: {
  expected: CheckoutResult;
  guard: CheckoutGuard;
  isCurrent: () => boolean;
  locale: string;
  onConfirmed: (result: CheckoutResult) => void;
  onUnavailable: () => void;
}) =>
  Effect.suspend(() => {
    if (
      !isCurrent() ||
      (expected.outcome !== "PLACED" && expected.outcome !== "REPLAYED") ||
      (expected.receipt !== null && expected.receipt !== undefined)
    ) {
      return Effect.void;
    }
    if (
      expected.orderId === null ||
      expected.orderNumber === null ||
      checkoutGuardKey(expected.scope) !== checkoutGuardKey(guard.scope)
    ) {
      onUnavailable();
      return Effect.void;
    }
    return recoverCheckoutProgram(guard, locale).pipe(
      Effect.match({
        onFailure: () => {
          if (isCurrent()) {
            onUnavailable();
          }
        },
        onSuccess: (recovered) => {
          if (!isCurrent()) {
            return;
          }
          if (
            recovered.state === "confirmed" &&
            recovered.result.orderId === expected.orderId &&
            recovered.result.orderNumber === expected.orderNumber &&
            checkoutGuardKey(recovered.result.scope) === checkoutGuardKey(guard.scope) &&
            recovered.result.receipt !== null &&
            recovered.result.receipt !== undefined
          ) {
            onConfirmed(recovered.result);
          } else {
            onUnavailable();
          }
        },
      }),
    );
  });
const dismissReceiptProgram = (guard: CheckoutGuard) =>
  withCheckoutLock(
    guard.scope,
    Effect.gen(function* dismissConfirmedReceipt() {
      const current = yield* readCheckoutGuard(guard.scope);
      if (current?.clientRequestId === guard.clientRequestId) {
        yield* removeCheckoutGuard(guard);
      }
    }),
  );
const failureNotice = (
  error: Effect.Error<ReturnType<typeof submitCheckoutProgram>>,
  placing: boolean,
): Notice =>
  Match.value(error).pipe(
    Match.tag("CheckoutGuardFailure", (value): Notice =>
      value.reason === "exists" || value.reason === "busy" ? "uncertain" : "storage",
    ),
    Match.tag("CheckoutDraftFailure", (draftFailure): Notice => draftFailure.reason),
    Match.tag("CheckoutInvalidProblem", (): Notice => "invalid"),
    Match.tag("CheckoutForbiddenProblem", (): Notice => "forbidden"),
    Match.tag("CheckoutScopeProblem", (): Notice => "scope-mismatch"),
    Match.tag("CheckoutUnavailableProblem", (): Notice => "unavailable"),
    Match.orElse((): Notice => (placing ? "uncertain" : "unavailable")),
  );
interface GuardObservation {
  error: boolean;
  guard: CheckoutGuard | null;
  key: string;
  loaded: boolean;
}
const observeGuard = (
  scope: CartScope,
  observationKey: string,
  accept: (value: GuardObservation) => void,
) =>
  readCheckoutGuard(scope).pipe(
    Effect.match({
      onFailure: () => accept({ error: true, guard: null, key: observationKey, loaded: true }),
      onSuccess: (guard) => accept({ error: false, guard, key: observationKey, loaded: true }),
    }),
  );

/** Observe only the in-memory shared Portal session; credentials never enter durable intent state. */
const useCheckoutSession = () => {
  const auth = usePortalAuth({ mode: "login" });
  // A new admission invalidates local work even when its serialized customer data is identical.
  // Server admission remains the authority for every request.
  const [previousSession, setPreviousSession] = useState(() => observeCheckoutSession(null, auth));
  const observed = observeCheckoutSession(previousSession, auth);
  const { generation: sessionGeneration } = observed;
  if (observed !== previousSession) {
    setPreviousSession(observed);
  }
  const currentSession = useRef(sessionGeneration);
  useLayoutEffect(() => {
    currentSession.current = sessionGeneration;
    return () => {
      // Also fence callbacks after this checkout unmounts.
      currentSession.current = -1;
    };
  }, [sessionGeneration]);
  return { currentSession, ready: auth.loaded && !auth.pending, sessionGeneration };
};

/** A repeated market is a new lifecycle; StrictMode replay keeps the same context. */
const useCheckoutContext = (key: string, sessionGeneration: number, locale: string) => {
  const [previousScope, setPreviousScope] = useState<QuoteSelection>({ generation: 0, key });
  const scopeSelection = advanceQuoteSelection(previousScope, key);
  if (scopeSelection !== previousScope) {
    setPreviousScope(scopeSelection);
  }
  const contextKey = JSON.stringify([key, scopeSelection.generation, sessionGeneration, locale]);
  const currentScope = useRef<string | null>(contextKey);
  useLayoutEffect(() => {
    currentScope.current = contextKey;
    return () => {
      currentScope.current = null;
    };
  }, [contextKey, currentScope]);
  return { contextKey, currentScope };
};

/** An intent survives reloads; only explicit receipt dismissal permits another order. */
export const useCheckout = (options: ReadyOptions, locale: string) => {
  const cart = useCart();
  const { currentSession, ready: sessionReady, sessionGeneration } = useCheckoutSession();
  const key = checkoutGuardKey(options.scope);
  const { contextKey, currentScope } = useCheckoutContext(key, sessionGeneration, locale);
  const [editVersion, setEditVersion] = useState(0);
  const [progress, setProgress] = useState<"idle" | "quote" | "place" | "recovery">("idle");
  const busy = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [quoteSnapshot, setQuoteSnapshot] = useState<
    (QuoteSelection & { result: CheckoutResult }) | null
  >(null);
  const [receipt, setReceipt] = useState<CheckoutResult | null>(null);
  const [receiptContext, setReceiptContext] = useState<string | null>(null);
  const receiptGuard = useRef<CheckoutGuard | null>(null);
  const automaticAttempts = useRef(new Set<string>());
  const [receiptEntries, setReceiptEntries] = useState<readonly CartEntry[]>([]);
  const [guardState, setGuardState] = useState<GuardObservation | null>(null);
  const lines = cartLineSnapshot(cart?.entries ?? []);
  const selectionKey = JSON.stringify([
    key,
    locale,
    options.countryCodes,
    options.shippingMethods,
    lines,
    editVersion,
    sessionGeneration,
  ]);
  const currentReceipt =
    receipt !== null && receiptContext === contextKey && checkoutGuardKey(receipt.scope) === key
      ? receipt
      : null;
  const [previousSelection, setPreviousSelection] = useState<QuoteSelection>({
    generation: 0,
    key: selectionKey,
  });
  const selection = advanceQuoteSelection(previousSelection, selectionKey);
  if (selection !== previousSelection) {
    setPreviousSelection(selection);
  }
  const quote =
    quoteSnapshot?.key === selectionKey && quoteSnapshot.generation === selection.generation
      ? quoteSnapshot.result
      : null;
  const activeGuard = guardState?.key === contextKey ? guardState : null;
  const restore = () => {
    if (currentSession.current === sessionGeneration && currentScope.current === contextKey) {
      clientRuntime.runSync(observeGuard(options.scope, contextKey, setGuardState));
    }
  };
  const complete = (result: CheckoutResult, submitted: CheckoutGuard, generation: number) => {
    if (
      currentSession.current !== generation ||
      currentScope.current !== contextKey ||
      key !== checkoutGuardKey(submitted.scope)
    ) {
      restore();
      return;
    }
    if (cart !== null && cart.entries.length > 0) {
      setReceiptEntries(cart.entries);
    }
    setReceipt(result);
    setReceiptContext(contextKey);
    receiptGuard.current = submitted;
    const cleared = cart?.clearSubmitted(submitted.lines) ?? false;
    if (cart !== null && cart.entries.length > 0 && !cleared) {
      setNotice("cart-preserved");
    }
    // Keep the nonce until receipt dismissal so refresh can recover canonical details.
    restore();
  };
  const finish = () => {
    busy.current = false;
    // Busy excludes newer operations; the mounted checkout must leave pending even after a scope/session change.
    if (currentSession.current !== -1 && currentScope.current !== null) {
      setProgress("idle");
    }
  };
  const submit = (
    fields: FormData,
    method: ReadyOptions["shippingMethods"][number] | undefined,
  ) => {
    if (
      busy.current ||
      !sessionReady ||
      (activeGuard?.guard !== null && activeGuard?.guard !== undefined) ||
      activeGuard?.error === true ||
      activeGuard?.loaded !== true
    ) {
      return;
    }
    if (
      cart === null ||
      !cart.loaded ||
      cart.error ||
      cart.scope === null ||
      checkoutGuardKey(cart.scope) !== key ||
      method === undefined
    ) {
      setNotice("invalid");
      return;
    }
    const placing = quote?.outcome === "VALID";
    const requestKey = selectionKey;
    const requestGeneration = selection.generation;
    const requestSession = sessionGeneration;
    busy.current = true;
    setProgress(placing ? "place" : "quote");
    setNotice(null);
    clientRuntime.runFork(
      submitCheckoutProgram({
        fields,
        isCurrentSession: () => currentSession.current === requestSession,
        lines: cartLineSnapshot(cart.entries),
        locale,
        method,
        placing,
        scope: options.scope,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            if (currentSession.current === requestSession && currentScope.current === contextKey) {
              setNotice(failureNotice(error, placing));
            }
            restore();
            return Effect.void;
          },
          onSuccess: ({ guard, result }) => {
            if (currentSession.current !== requestSession || currentScope.current !== contextKey) {
              restore();
              return Effect.void;
            }
            if (result.outcome === "PLACED" || result.outcome === "REPLAYED") {
              complete(result, guard, requestSession);
              if (result.receipt === null || result.receipt === undefined) {
                setProgress("recovery");
                return recoverConfirmedCheckoutProgram({
                  expected: result,
                  guard,
                  isCurrent: () =>
                    currentSession.current === requestSession &&
                    currentScope.current === contextKey &&
                    receiptGuard.current !== null &&
                    receiptGuard.current.clientRequestId === guard.clientRequestId &&
                    checkoutGuardKey(receiptGuard.current.scope) === key,
                  locale,
                  // The placement has already cleared its submitted lines. Only enrich the receipt.
                  onConfirmed: setReceipt,
                  onUnavailable: () => {
                    // Keep the committed success. Returning to idle exposes the explicit read retry.
                  },
                });
              }
            } else {
              setQuoteSnapshot({ generation: requestGeneration, key: requestKey, result });
              if (result.outcome === "REJECTED") {
                setNotice("invalid");
              }
              restore();
            }
            return Effect.void;
          },
        }),
        Effect.ensuring(Effect.sync(finish)),
      ),
    );
  };
  const recover = (observedGuard?: CheckoutGuard) => {
    const guard =
      observedGuard ?? (currentReceipt === null ? activeGuard?.guard : receiptGuard.current);
    if (
      busy.current ||
      !sessionReady ||
      guard === null ||
      guard === undefined ||
      checkoutGuardKey(guard.scope) !== key
    ) {
      return;
    }
    busy.current = true;
    const requestSession = sessionGeneration;
    setProgress("recovery");
    setNotice(null);
    if (currentReceipt !== null) {
      const isCurrent = () =>
        currentSession.current === requestSession &&
        currentScope.current === contextKey &&
        receiptGuard.current !== null &&
        receiptGuard.current.clientRequestId === guard.clientRequestId &&
        checkoutGuardKey(receiptGuard.current.scope) === key;
      clientRuntime.runFork(
        recoverConfirmedCheckoutProgram({
          expected: currentReceipt,
          guard,
          isCurrent,
          locale,
          // A receipt retry must not clear a cart refilled after the original placement.
          onConfirmed: setReceipt,
          onUnavailable: () => {
            if (isCurrent()) {
              setNotice("unavailable");
            }
          },
        }).pipe(Effect.ensuring(Effect.sync(finish))),
      );
      return;
    }
    clientRuntime.runFork(
      recoverStoredCheckoutProgram({
        guard,
        isCurrent: () =>
          currentSession.current === requestSession && currentScope.current === contextKey,
        locale,
        onConfirmed: (result) => complete(result, guard, requestSession),
        onUnavailable: () => {
          setNotice("uncertain");
          restore();
        },
      }).pipe(Effect.ensuring(Effect.sync(finish))),
    );
  };
  const observeStoredIntent = useEffectEvent((scope: CartScope, observedContext: string) => {
    clientRuntime.runFork(
      observeGuard(scope, observedContext, (observed) => {
        if (
          !sessionReady ||
          currentSession.current !== sessionGeneration ||
          currentScope.current !== observedContext
        ) {
          return;
        }
        setGuardState(observed);
        if (busy.current || currentReceipt !== null || observed.error || observed.guard === null) {
          return;
        }
        const attempt = JSON.stringify([observedContext, observed.guard.clientRequestId]);
        if (!automaticAttempts.current.has(attempt)) {
          automaticAttempts.current.add(attempt);
          recover(observed.guard);
        }
      }),
    );
  });
  useEffect(() => {
    observeStoredIntent(options.scope, contextKey);
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        observeStoredIntent(options.scope, contextKey);
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [contextKey, key, options.scope]);
  const dismiss = (onDone: () => void) => {
    if (busy.current || currentReceipt === null || receiptGuard.current === null) {
      return;
    }
    busy.current = true;
    clientRuntime.runFork(
      dismissReceiptProgram(receiptGuard.current).pipe(
        Effect.match({
          onFailure: () => setNotice("storage"),
          onSuccess: () => {
            restore();
            onDone();
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            busy.current = false;
          }),
        ),
      ),
    );
  };
  return {
    cart,
    dismiss,
    guarded: activeGuard?.guard !== null && activeGuard?.guard !== undefined,
    guardLoaded: activeGuard?.loaded ?? false,
    handleEdit: () => {
      setEditVersion((previous) => previous + 1);
      setNotice(null);
    },
    notice: activeGuard?.error === true ? "storage" : notice,
    progress,
    quote,
    receipt: currentReceipt,
    receiptEntries: currentReceipt === null ? [] : receiptEntries,
    recover,
    submit,
  };
};
