import { describe, expect } from "@rstest/core";
import { it } from "effect-rstest";
import { Deferred, Effect, Exit, Fiber } from "effect";
import {
  inquiryGuardKey,
  readInquiryBarrier,
  submitGuardedInquiry,
} from "../src/features/inquiry-guard";
import type { InquiryGuardStorage } from "../src/features/inquiry-guard";
import type { CheckoutLockManager } from "../src/features/checkout-guard";
import type { Inquiry, InquiryOutcome } from "../src/ontos/inquiry";
import { startInquirySubmission } from "../src/ontos/inquiry-client";
import type { InquirySubmissionRef } from "../src/ontos/inquiry-client";

const fields = (name = "Private Shopper") => {
  const value = new FormData();
  for (const [key, content] of Object.entries({
    email: "private@example.test",
    message: "Private question",
    name,
    phone: "+420123456789",
  })) {
    value.set(key, content);
  }
  return value;
};
const store = () => {
  const data = new Map<string, string>();
  const storage: InquiryGuardStorage = {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  return { data, storage };
};
const locks = (): CheckoutLockManager => {
  let held = false;
  return {
    request: async <A>(
      name: string,
      _options: { ifAvailable: true; mode: "exclusive" },
      granted: (lock: Lock | null) => Promise<A>,
    ) => {
      if (held) {
        return await granted(null);
      }
      held = true;
      try {
        return await granted({ mode: "exclusive", name });
      } finally {
        held = false;
      }
    },
  };
};
const storageUnavailable = () => {
  throw new Error("Storage unavailable");
};
const acknowledged = () => {
  let calls = 0;
  return {
    count: () => calls,
    send: () =>
      Effect.sync((): InquiryOutcome => {
        calls += 1;
        return { state: "sent", taskId: "native-task" };
      }),
  };
};

describe("contact inquiry durable uncertainty", () => {
  it.effect(
    "keeps only a nonce after an unknown outcome; reload, locale and product changes cannot resend",
    () =>
      Effect.gen(function* reloadUnknown() {
        const memory = store();
        let sends = 0;
        const ports = {
          locks: locks(),
          send: () =>
            Effect.sync((): InquiryOutcome => {
              sends += 1;
              return { state: "unconfirmed" };
            }),
          storage: memory.storage,
        };
        expect((yield* submitGuardedInquiry(fields(), "cs", undefined, ports)).state).toBe(
          "unconfirmed",
        );
        const saved = memory.data.get(inquiryGuardKey);
        expect(saved).toBeDefined();
        expect(Object.keys(JSON.parse(saved ?? "null")).toSorted()).toEqual([
          "requestId",
          "version",
        ]);
        for (const secret of [
          "Private Shopper",
          "private@example.test",
          "Private question",
          "+420123456789",
        ]) {
          expect(saved).not.toContain(secret);
        }
        expect(yield* readInquiryBarrier(memory.storage)).toBe(true);
        expect(
          (yield* submitGuardedInquiry(
            fields(),
            "en",
            { productId: "another-product", variantIds: [] },
            ports,
          )).state,
        ).toBe("unconfirmed");
        expect(sends).toBe(1);
        expect(memory.data.get(inquiryGuardKey)).toBe(saved);
      }),
  );

  it.effect(
    "saves and reads back the marker before dispatch; real ACK releases it for a later new question",
    () =>
      Effect.gen(function* confirmedInquiry() {
        const memory = store();
        const ids: string[] = [];
        const send = (input: Inquiry) =>
          Effect.sync((): InquiryOutcome => {
            expect(JSON.parse(memory.data.get(inquiryGuardKey) ?? "null").requestId).toBe(
              input.requestId,
            );
            ids.push(input.requestId);
            return { state: "sent", taskId: "native-task" };
          });
        const ports = { locks: locks(), send, storage: memory.storage };
        expect((yield* submitGuardedInquiry(fields(), "cs", undefined, ports)).state).toBe("sent");
        expect(yield* readInquiryBarrier(memory.storage)).toBe(false);
        yield* submitGuardedInquiry(fields(), "cs", undefined, ports);
        expect(new Set(ids).size).toBe(2);
      }),
  );

  for (const state of ["invalid", "forbidden", "unavailable"] as const) {
    it.effect(
      `allows a corrected submission after the typed definitive pre-write outcome ${state}`,
      () =>
        Effect.gen(function* safeRefusal() {
          const memory = store();
          let sends = 0;
          const ports = {
            locks: locks(),
            send: () =>
              Effect.sync((): InquiryOutcome => {
                sends += 1;
                return sends === 1 ? { state } : { state: "sent", taskId: "native-task" };
              }),
            storage: memory.storage,
          };
          expect((yield* submitGuardedInquiry(fields(), "cs", undefined, ports)).state).toBe(state);
          expect(yield* readInquiryBarrier(memory.storage)).toBe(false);
          expect((yield* submitGuardedInquiry(fields(), "cs", undefined, ports)).state).toBe(
            "sent",
          );
          expect(sends).toBe(2);
        }),
    );
  }

  it.effect("rejects local validation before storage admission or dispatch", () =>
    Effect.gen(function* invalidInput() {
      const memory = store();
      const owner = acknowledged();
      const ports = {
        locks: locks(),
        send: owner.send,
        storage: memory.storage,
      };
      expect((yield* submitGuardedInquiry(fields("   "), "cs", undefined, ports)).state).toBe(
        "invalid",
      );
      expect(memory.data.size).toBe(0);
      expect(owner.count()).toBe(0);
      expect((yield* submitGuardedInquiry(fields(), "cs", undefined, ports)).state).toBe("sent");
    }),
  );

  it.effect(
    "storage read/write/readback failures and unsupported locks fail before any dispatch",
    () =>
      Effect.gen(function* storageAdmission() {
        const memory = store();
        const owner = acknowledged();
        const { send } = owner;
        for (const storage of [
          { ...memory.storage, getItem: storageUnavailable },
          { ...memory.storage, setItem: storageUnavailable },
          { ...memory.storage, setItem: () => {} },
        ]) {
          expect(
            (yield* submitGuardedInquiry(fields(), "cs", undefined, {
              locks: locks(),
              send,
              storage,
            })).state,
          ).toBe("unavailable");
        }
        expect(
          (yield* submitGuardedInquiry(fields(), "cs", undefined, {
            locks: null,
            send,
            storage: memory.storage,
          })).state,
        ).toBe("unavailable");
        expect(owner.count()).toBe(0);
      }),
  );

  it.effect(
    "preserves a corrupt stored barrier and never clears a successful ACK's marker if storage fails",
    () =>
      Effect.gen(function* cleanupFailure() {
        const memory = store();
        const owner = acknowledged();
        const { send } = owner;
        memory.data.set(inquiryGuardKey, "invalid json");
        expect(
          (yield* submitGuardedInquiry(fields(), "cs", undefined, {
            locks: locks(),
            send,
            storage: memory.storage,
          })).state,
        ).toBe("unconfirmed");
        expect(memory.data.get(inquiryGuardKey)).toBe("invalid json");
        expect(owner.count()).toBe(0);
        memory.data.clear();
        const storage = {
          ...memory.storage,
          removeItem: storageUnavailable,
        };
        expect(
          (yield* submitGuardedInquiry(fields(), "cs", undefined, {
            locks: locks(),
            send,
            storage,
          })).state,
        ).toBe("sent");
        expect(yield* readInquiryBarrier(memory.storage)).toBe(true);
        expect(
          (yield* submitGuardedInquiry(fields(), "cs", undefined, {
            locks: locks(),
            send,
            storage: memory.storage,
          })).state,
        ).toBe("unconfirmed");
        expect(owner.count()).toBe(1);
      }),
  );

  it.effect("serializes two tabs and allows only one dispatch while an ACK is pending", () =>
    Effect.gen(function* twoTabs() {
      const memory = store();
      const started = yield* Deferred.make<null>();
      const finish = yield* Deferred.make<null>();
      let sends = 0;
      const send = () =>
        Effect.gen(function* pendingNative() {
          sends += 1;
          yield* Deferred.succeed(started, null);
          yield* Deferred.await(finish);
          return { state: "sent" as const, taskId: "native-task" };
        });
      const ports = { locks: locks(), send, storage: memory.storage };
      const first = yield* submitGuardedInquiry(fields(), "cs", undefined, ports).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      expect((yield* submitGuardedInquiry(fields(), "cs", undefined, ports)).state).toBe(
        "unconfirmed",
      );
      expect(sends).toBe(1);
      yield* Deferred.succeed(finish, null);
      expect((yield* Fiber.join(first)).state).toBe("sent");
      expect(memory.data.size).toBe(0);
    }),
  );

  it.effect("a program defect preserves the barrier instead of allowing a fresh request", () =>
    Effect.gen(function* defectAfterDispatch() {
      const memory = store();
      let sends = 0;
      const ports = {
        locks: locks(),
        send: () =>
          Effect.sync(() => {
            sends += 1;
          }).pipe(Effect.andThen(Effect.die("offline simulated defect"))),
        storage: memory.storage,
      };
      const exit = yield* submitGuardedInquiry(fields(), "cs", undefined, ports).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* readInquiryBarrier(memory.storage)).toBe(true);
      expect((yield* submitGuardedInquiry(fields(), "cs", undefined, ports)).state).toBe(
        "unconfirmed",
      );
      expect(sends).toBe(1);
    }),
  );

  it.effect(
    "component interruption cannot release an uncertain intent after losing its observer",
    () =>
      Effect.gen(function* interruptedForm() {
        const memory = store();
        const started = yield* Deferred.make<null>();
        const finish = yield* Deferred.make<null>();
        const ports = {
          locks: locks(),
          send: () =>
            Deferred.succeed(started, null).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as<InquiryOutcome>({ state: "unconfirmed" }),
            ),
          storage: memory.storage,
        };
        const active: InquirySubmissionRef = { current: null };
        const outcomes: InquiryOutcome[] = [];
        startInquirySubmission(
          active,
          (outcome) => {
            outcomes.push(outcome);
          },
          submitGuardedInquiry(fields(), "cs", undefined, ports),
        );
        yield* Deferred.await(started);
        const running = active.current;
        expect(running).not.toBeNull();
        if (running === null) {
          return;
        }
        active.current = null;
        const interruption = yield* Fiber.interrupt(running).pipe(Effect.forkChild);
        yield* Deferred.succeed(finish, null);
        yield* Fiber.join(interruption);
        expect(outcomes).toEqual([]);
        expect(yield* readInquiryBarrier(memory.storage)).toBe(true);
      }),
  );
});
