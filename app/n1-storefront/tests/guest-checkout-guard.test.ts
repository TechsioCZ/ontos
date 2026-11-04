import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema } from "effect";
import {
  cartLineSnapshot,
  clearSubmittedCart,
  CheckoutGuardFailure,
  CheckoutGuardSchema,
  checkoutGuardKey,
  readCheckoutGuard,
  removeCheckoutGuard,
  sameCheckoutLines,
  saveCheckoutGuard,
  withCheckoutLock,
} from "../src/features/checkout-guard";
import { cartStorageKey } from "../src/features/cart-state";
import type {
  CheckoutGuard,
  CheckoutGuardStorage,
  CheckoutLockManager,
} from "../src/features/checkout-guard";

const scope = {
  currency: "CZK",
  legalEntityId: "71000000-0000-4000-8000-000000000002",
  marketId: "n1-cz",
  tenantId: "71000000-0000-4000-8000-000000000001",
} satisfies CheckoutGuard["scope"];
const line = { expectedUnitPriceMinor: 12_100, productId: "p1", quantity: 2, variantId: "v1" };
const cartEntry = {
  ...line,
  image: null,
  name: "Product",
  sku: "SKU",
  slug: "product",
  unit: "ks",
  variantName: "Large",
};
const guard = {
  clientRequestId: "70000000-0000-4000-8000-000000000005",
  lines: [line],
  scope,
  version: 1,
} satisfies CheckoutGuard;
const makeStorage = () => {
  const records = new Map<string, string>();
  const storage: CheckoutGuardStorage = {
    getItem: (key) => records.get(key) ?? null,
    removeItem: (key) => {
      records.delete(key);
    },
    setItem: (key, value) => {
      records.set(key, value);
    },
  };
  return { records, storage };
};
const makeLocks = (): CheckoutLockManager => {
  const held = new Set<string>();
  return {
    request: async <A>(
      name: string,
      _options: { ifAvailable: true; mode: "exclusive" },
      onGranted: (lock: Lock | null) => Promise<A>,
    ) => {
      if (held.has(name)) {
        return await onGranted(null);
      }
      held.add(name);
      return await onGranted({ mode: "exclusive", name }).finally(() => {
        held.delete(name);
      });
    },
  };
};

describe("guest checkout persisted submission guard", () => {
  it.effect("keeps a fresh cart unblocked and stores only its submission identity and lines", () =>
    Effect.gen(function* safeStorage() {
      const { records, storage } = makeStorage();
      expect(yield* readCheckoutGuard(scope, storage)).toBeNull();
      yield* saveCheckoutGuard(guard, storage);
      expect(yield* readCheckoutGuard(scope, storage)).toEqual(guard);
      const saved = records.get(checkoutGuardKey(scope));
      expect(saved).not.toContain("email");
      expect(saved).not.toContain("address");
      expect(saved).not.toContain("contact");
      expect(saved).not.toContain("password");
    }),
  );
  it.effect(
    "restores an unresolved submission after a page reload without creating a new nonce",
    () =>
      Effect.gen(function* restoreUnconfirmed() {
        const { storage } = makeStorage();
        yield* saveCheckoutGuard(guard, storage);
        expect(yield* readCheckoutGuard(scope, storage)).toEqual(guard);
        const next = { ...guard, clientRequestId: "70000000-0000-4000-8000-000000000006" };
        const failure = yield* Effect.flip(saveCheckoutGuard(next, storage));
        expect(failure.reason).toBe("exists");
        expect(yield* readCheckoutGuard(scope, storage)).toEqual(guard);
      }),
  );
  it.effect("refuses corrupt storage instead of making the cart eligible for another order", () =>
    Effect.gen(function* corruptGuard() {
      const { records, storage } = makeStorage();
      records.set(checkoutGuardKey(scope), "not-json");
      expect((yield* Effect.flip(readCheckoutGuard(scope, storage))).reason).toBe("invalid");
      expect((yield* Effect.flip(saveCheckoutGuard(guard, storage))).reason).toBe("exists");
      expect((yield* Effect.flip(removeCheckoutGuard(guard, storage))).reason).toBe("invalid");
      expect(records.get(checkoutGuardKey(scope))).toBe("not-json");
    }),
  );
  it.effect("rejects a foreign scope and forbids personal fields at every nesting level", () =>
    Effect.gen(function* rejectForeignOrPersonalData() {
      const { records, storage } = makeStorage();
      records.set(
        checkoutGuardKey(scope),
        JSON.stringify({ ...guard, scope: { ...scope, marketId: "other" } }),
      );
      expect((yield* Effect.flip(readCheckoutGuard(scope, storage))).reason).toBe("scope-mismatch");
      for (const value of [
        { ...guard, contact: { email: "buyer@example.test" } },
        { ...guard, scope: { ...scope, email: "buyer@example.test" } },
        { ...guard, lines: [{ ...line, address: "private" }] },
      ]) {
        records.set(checkoutGuardKey(scope), JSON.stringify(value));
        expect((yield* Effect.flip(readCheckoutGuard(scope, storage))).reason).toBe("invalid");
      }
    }),
  );
  it.effect("cannot clear another intent or a changed submitted snapshot", () =>
    Effect.gen(function* preserveDifferentIntent() {
      const { storage } = makeStorage();
      yield* saveCheckoutGuard(guard, storage);
      for (const changed of [
        { ...guard, clientRequestId: "70000000-0000-4000-8000-000000000006" },
        { ...guard, lines: [{ ...line, quantity: 3 }] },
      ]) {
        expect((yield* Effect.flip(removeCheckoutGuard(changed, storage))).reason).toBe("exists");
        expect(yield* readCheckoutGuard(scope, storage)).toEqual(guard);
      }
      yield* removeCheckoutGuard(guard, storage);
      expect(yield* readCheckoutGuard(scope, storage)).toBeNull();
    }),
  );
  it.effect("preserves the unknown submission when the owner program fails", () =>
    Effect.gen(function* preserveUnknownCommit() {
      class UnknownCommit extends Schema.TaggedError<UnknownCommit>()("UnknownCommit", {}) {}
      const { storage } = makeStorage();
      const program = saveCheckoutGuard(guard, storage).pipe(
        Effect.andThen(Effect.fail(new UnknownCommit())),
      );
      const failure = yield* Effect.flip(withCheckoutLock(scope, program, makeLocks()));
      expect(failure).toBeInstanceOf(UnknownCommit);
      expect(yield* readCheckoutGuard(scope, storage)).toEqual(guard);
    }),
  );
  it.effect(
    "keeps the exclusive lock through the pending owner call so a second tab cannot submit",
    () =>
      Effect.gen(function* competingTabs() {
        const locks = makeLocks();
        const { storage } = makeStorage();
        const started = yield* Deferred.make<boolean>();
        const finish = yield* Deferred.make<boolean>();
        let calls = 0;
        const first = withCheckoutLock(
          scope,
          Effect.gen(function* firstTab() {
            yield* saveCheckoutGuard(guard, storage);
            calls += 1;
            yield* Deferred.succeed(started, true);
            yield* Deferred.await(finish);
            yield* removeCheckoutGuard(guard, storage);
          }),
          locks,
        );
        const fiber = yield* Effect.forkChild(first);
        yield* Deferred.await(started);
        const second = yield* Effect.flip(
          withCheckoutLock(
            scope,
            Effect.sync(() => {
              calls += 1;
            }),
            locks,
          ),
        );
        expect(second).toBeInstanceOf(CheckoutGuardFailure);
        expect(second.reason).toBe("busy");
        expect(calls).toBe(1);
        yield* Deferred.succeed(finish, true);
        yield* Fiber.join(fiber);
        expect(yield* readCheckoutGuard(scope, storage)).toBeNull();
      }),
  );
  it.effect("reports a blocked storage write before reaching the owner call", () =>
    Effect.gen(function* storageBlocked() {
      const { storage } = makeStorage();
      const blocked: CheckoutGuardStorage = {
        ...storage,
        setItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      };
      let called = false;
      const program = saveCheckoutGuard(guard, blocked).pipe(
        Effect.andThen(
          Effect.sync(() => {
            called = true;
          }),
        ),
      );
      const failure = yield* Effect.flip(withCheckoutLock(scope, program, makeLocks()));
      expect(failure.reason).toBe("storage");
      expect(called).toBe(false);
    }),
  );
  it.effect("does not dispatch when the browser cannot coordinate checkout tabs", () =>
    Effect.gen(function* unsupportedLocks() {
      let called = false;
      const failure = yield* Effect.flip(
        withCheckoutLock(
          scope,
          Effect.sync(() => {
            called = true;
          }),
          null,
        ),
      );
      expect(failure.reason).toBe("unsupported");
      expect(called).toBe(false);
    }),
  );
  it.effect("retains a program defect rather than classifying it as a storage failure", () =>
    Effect.gen(function* retainDefect() {
      const result = yield* Effect.exit(
        withCheckoutLock(scope, Effect.die("checkout-test-defect"), makeLocks()),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain("checkout-test-defect");
      }
    }),
  );
  it("compares only the actual submitted lines, including variant, price and quantity", () => {
    const entry = {
      ...line,
      image: null,
      name: "Product",
      sku: "SKU",
      slug: "product",
      unit: "ks",
      variantName: "Large",
    };
    const lines = cartLineSnapshot([entry]);
    expect(lines).toEqual(guard.lines);
    expect(sameCheckoutLines(lines, guard.lines)).toBe(true);
    for (const change of [
      { quantity: 3 },
      { expectedUnitPriceMinor: 12_101 },
      { variantId: "v2" },
      { productId: "p2" },
    ]) {
      expect(sameCheckoutLines(lines, [{ ...line, ...change }])).toBe(false);
    }
    expect(sameCheckoutLines(lines, [])).toBe(false);
  });
  it.effect("rejects zero amounts and duplicate line identities in saved guards", () =>
    Effect.gen(function* invalidSnapshot() {
      for (const value of [
        { ...guard, lines: [{ ...line, quantity: 0 }] },
        { ...guard, lines: [line, line] },
      ]) {
        const failure = yield* Effect.result(
          Schema.decodeUnknownEffect(CheckoutGuardSchema)(value),
        );
        expect(Result.isFailure(failure)).toBe(true);
      }
    }),
  );
});

describe("confirmed checkout cart cleanup", () => {
  it.effect("clears the exact submitted cart once and leaves other storage untouched", () =>
    Effect.gen(function* exactCart() {
      const { records, storage } = makeStorage();
      const key = cartStorageKey(scope);
      records.set(key, JSON.stringify({ entries: [cartEntry], scope, version: 1 }));
      records.set("unrelated-cart", "keep");
      let removals = 0;
      const observed: CheckoutGuardStorage = {
        ...storage,
        removeItem: (removedKey) => {
          removals += 1;
          storage.removeItem(removedKey);
        },
      };
      expect(yield* clearSubmittedCart(scope, guard.lines, observed)).toBe(true);
      expect(records.has(key)).toBe(false);
      expect(yield* clearSubmittedCart(scope, guard.lines, observed)).toBe(false);
      expect(removals).toBe(1);
      expect(records.get("unrelated-cart")).toBe("keep");
    }),
  );
  it.effect("preserves edits made after submission and newly added cart lines", () =>
    Effect.gen(function* editedCart() {
      for (const entries of [
        [{ ...cartEntry, quantity: 3 }],
        [{ ...cartEntry, expectedUnitPriceMinor: 12_101 }],
        [{ ...cartEntry, variantId: "v2" }],
        [{ ...cartEntry, productId: "p2" }],
        [cartEntry, { ...cartEntry, productId: "p2" }],
      ]) {
        const { records, storage } = makeStorage();
        const key = cartStorageKey(scope);
        const raw = JSON.stringify({ entries, scope, version: 1 });
        records.set(key, raw);
        expect(yield* clearSubmittedCart(scope, guard.lines, storage)).toBe(false);
        expect(records.get(key)).toBe(raw);
      }
    }),
  );
  it.effect("rejects foreign scope or corrupt cart storage without deleting it", () =>
    Effect.gen(function* foreignOrCorruptCart() {
      for (const raw of [
        "not-json",
        JSON.stringify({
          entries: [cartEntry],
          scope: { ...scope, marketId: "other" },
          version: 1,
        }),
        JSON.stringify({ entries: [{ ...cartEntry, quantity: 0 }], scope, version: 1 }),
      ]) {
        const { records, storage } = makeStorage();
        const key = cartStorageKey(scope);
        records.set(key, raw);
        const failure = yield* Effect.flip(clearSubmittedCart(scope, guard.lines, storage));
        expect(failure.reason).toBe("invalid");
        expect(records.get(key)).toBe(raw);
      }
    }),
  );
  it.effect(
    "reports storage access and deletion failures without claiming successful cleanup",
    () =>
      Effect.gen(function* blockedCartStorage() {
        const { records, storage } = makeStorage();
        const key = cartStorageKey(scope);
        const raw = JSON.stringify({ entries: [cartEntry], scope, version: 1 });
        records.set(key, raw);
        const unreadable: CheckoutGuardStorage = {
          ...storage,
          getItem: () => {
            throw new DOMException("blocked", "SecurityError");
          },
        };
        const undeletable: CheckoutGuardStorage = {
          ...storage,
          removeItem: () => {
            throw new DOMException("blocked", "SecurityError");
          },
        };
        for (const blocked of [unreadable, undeletable]) {
          const failure = yield* Effect.flip(clearSubmittedCart(scope, guard.lines, blocked));
          expect(failure.reason).toBe("storage");
          expect(records.get(key)).toBe(raw);
        }
      }),
  );
});
