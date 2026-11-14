"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Effect, Schema } from "effect";
import type { CartScope, CartQuoteRequest } from "@/ontos/cart-quote";
import { clientRuntime } from "@/ontos/client-runtime";
import { clearSubmittedCart } from "./checkout-guard";
import {
  addCartEntry,
  cartLineKey,
  cartStorageKey,
  decodeStoredCart,
  replaceCartQuantity,
} from "./cart-state";
import type { CartEntry } from "./cart-state";

class CartStorageUnavailable extends Schema.TaggedError<CartStorageUnavailable>()(
  "CartStorageUnavailable",
  {},
) {}
interface CartState {
  entries: readonly CartEntry[];
  error: boolean;
  key: string | null;
  loaded: boolean;
}
interface CartContextValue {
  acceptPrice: (entry: CartEntry, price: number) => boolean;
  add: (entry: CartEntry) => boolean;
  clear: () => void;
  clearSubmitted: (lines: CartQuoteRequest["lines"]) => boolean;
  entries: readonly CartEntry[];
  error: boolean;
  imageHosts: readonly string[];
  loaded: boolean;
  remove: (entry: CartEntry) => boolean;
  scope: CartScope | null;
  update: (entry: CartEntry, quantity: number) => boolean;
}
// State and dispatcher retain their React identities. Server scope and the
// local unverified draft have separate lifecycles and ownership.
const StateContext = createContext<CartState | null>(null);
const DispatchContext = createContext<Dispatch<SetStateAction<CartState>> | null>(null);
const ScopeContext = createContext<CartScope | null>(null);
const ImagesContext = createContext<readonly string[]>([]);
const emptyEntries: readonly CartEntry[] = [];
const readSavedCart = (key: string, scope: CartScope) =>
  Effect.try({
    catch: () => new CartStorageUnavailable(),
    try: () => window.localStorage.getItem(key),
  }).pipe(
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed<readonly CartEntry[]>([])
        : decodeStoredCart(raw, scope).pipe(Effect.map((cart) => cart.entries)),
    ),
  );

export const CartProvider = ({
  children,
  imageHosts,
  scope,
}: {
  children: ReactNode;
  imageHosts: readonly string[];
  scope: CartScope | null;
}) => {
  const key = scope === null ? null : cartStorageKey(scope);
  const [state, setState] = useState<CartState>({
    entries: [],
    error: false,
    key: null,
    loaded: false,
  });
  useEffect(() => {
    const restore = () => {
      if (scope === null || key === null) {
        return;
      }
      const result = clientRuntime.runSync(
        readSavedCart(key, scope).pipe(
          Effect.match({
            onFailure: () => ({ entries: emptyEntries, error: true }),
            onSuccess: (entries) => ({ entries, error: false }),
          }),
        ),
      );
      setState({ ...result, key, loaded: true });
    };
    restore();
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        restore();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, [key, scope]);
  return (
    <ScopeContext value={scope}>
      <ImagesContext value={imageHosts}>
        <StateContext value={state}>
          <DispatchContext value={setState}>{children}</DispatchContext>
        </StateContext>
      </ImagesContext>
    </ScopeContext>
  );
};

export const useCart = (): CartContextValue | null => {
  const state = useContext(StateContext);
  const setState = useContext(DispatchContext);
  const scope = useContext(ScopeContext);
  const imageHosts = useContext(ImagesContext);
  if (state === null || setState === null) {
    return null;
  }
  const key = scope === null ? null : cartStorageKey(scope);
  const active = state.key === key;
  const loaded = active && state.loaded;
  const entries = active ? state.entries : emptyEntries;
  const save = <E,>(program: Effect.Effect<readonly CartEntry[], E>) => {
    if (!loaded || scope === null || key === null || state.error) {
      return false;
    }
    const result = clientRuntime.runSync(
      program.pipe(
        Effect.flatMap((updated) =>
          Effect.try({
            catch: () => new CartStorageUnavailable(),
            try: () => {
              window.localStorage.setItem(
                key,
                JSON.stringify({ entries: updated, scope, version: 1 }),
              );
              return updated;
            },
          }),
        ),
        Effect.match({ onFailure: () => null, onSuccess: (updated) => updated }),
      ),
    );
    if (result === null) {
      return false;
    }
    setState({ entries: result, error: false, key, loaded: true });
    return true;
  };
  const clear = () => {
    if (key === null) {
      return;
    }
    const success = clientRuntime.runSync(
      Effect.try({
        catch: () => new CartStorageUnavailable(),
        try: () => window.localStorage.removeItem(key),
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
    );
    setState((previous) =>
      success ? { entries: [], error: false, key, loaded: true } : { ...previous, error: true },
    );
  };
  return {
    acceptPrice: (entry, price) =>
      save(
        addCartEntry(
          entries.filter((line) => cartLineKey(line) !== cartLineKey(entry)),
          { ...entry, expectedUnitPriceMinor: price },
        ),
      ),
    add: (entry) => save(addCartEntry(entries, entry)),
    clear,
    clearSubmitted: (lines) => {
      if (!loaded || scope === null || key === null || state.error) {
        return false;
      }
      const success = clientRuntime.runSync(
        clearSubmittedCart(scope, lines).pipe(
          Effect.match({ onFailure: () => false, onSuccess: (cleared) => cleared }),
        ),
      );
      if (success) {
        setState((previous) =>
          previous.key === key ? { entries: [], error: false, key, loaded: true } : previous,
        );
      }
      return success;
    },
    entries,
    error: active && state.error,
    imageHosts,
    loaded,
    remove: (entry) =>
      save(Effect.succeed(entries.filter((line) => cartLineKey(line) !== cartLineKey(entry)))),
    scope,
    update: (entry, quantity) => save(replaceCartQuantity(entries, entry, quantity)),
  };
};
