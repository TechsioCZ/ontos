"use client";

import { Effect, Exit, Match, Result, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { decodeInquiry } from "@/ontos/inquiry";
import type { Inquiry, InquiryOutcome, InquiryProduct } from "@/ontos/inquiry";
import { inquiryRuntime, submitInquiry } from "@/ontos/inquiry-client";
import type { CheckoutLockManager } from "./checkout-guard";

// One unresolved N1 inquiry per browser origin, across locales/products. No customer fields are stored.
export const inquiryGuardKey = "n1-inquiry-submission-v1";
const Marker = Schema.Struct({
  requestId: Schema.String.check(Schema.isUUID()),
  version: Schema.Literal(1),
});
export type InquiryGuardStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export class InquiryGuardFailure extends Schema.TaggedError<InquiryGuardFailure>()(
  "InquiryGuardFailure",
  { reason: Schema.Literals(["blocked", "busy", "storage", "unsupported"]) },
) {}
interface InquiryGuardPorts {
  locks?: CheckoutLockManager | null;
  send?: (inquiry: Inquiry) => Effect.Effect<InquiryOutcome, never, HttpClient.HttpClient>;
  storage?: InquiryGuardStorage;
}
const io = <A>(read: () => A) =>
  Effect.try({ catch: () => new InquiryGuardFailure({ reason: "storage" }), try: read });
const resolveStorage = (storage?: InquiryGuardStorage) => io(() => storage ?? window.localStorage);
const readMarker = (storage: InquiryGuardStorage) =>
  io(() => storage.getItem(inquiryGuardKey)).pipe(
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(null)
        : Schema.decodeUnknownEffect(Schema.fromJsonString(Marker), { onExcessProperty: "error" })(
            raw,
          ).pipe(Effect.mapError(() => new InquiryGuardFailure({ reason: "blocked" }))),
    ),
  );
export const readInquiryBarrier = (storage?: InquiryGuardStorage) =>
  resolveStorage(storage).pipe(
    Effect.flatMap(readMarker),
    Effect.map((marker) => marker !== null),
  );

const clearOwnMarker = (storage: InquiryGuardStorage, requestId: string) =>
  Effect.gen(function* clearAcknowledgedInquiry() {
    const marker = yield* readMarker(storage);
    if (marker?.requestId !== requestId) {
      return yield* new InquiryGuardFailure({ reason: "blocked" });
    }
    yield* io(() => storage.removeItem(inquiryGuardKey));
    if ((yield* io(() => storage.getItem(inquiryGuardKey))) !== null) {
      return yield* new InquiryGuardFailure({ reason: "storage" });
    }
    return true;
  });

const guardedSubmission = (
  fields: FormData,
  locale: string,
  product: InquiryProduct | undefined,
  ports: InquiryGuardPorts,
) =>
  Effect.gen(function* persistInquiryIntentBeforeDispatch() {
    const storage = yield* resolveStorage(ports.storage);
    if ((yield* readMarker(storage)) !== null) {
      return yield* new InquiryGuardFailure({ reason: "blocked" });
    }
    const requestId = yield* io(() => crypto.randomUUID());
    const draft = {
      email: fields.get("email"),
      locale,
      message: fields.get("message"),
      name: fields.get("name"),
      phone: fields.get("phone"),
      requestId,
    };
    const inquiry = yield* decodeInquiry(product === undefined ? draft : { ...draft, product });
    const bytes = JSON.stringify({ requestId, version: 1 });
    yield* io(() => storage.setItem(inquiryGuardKey, bytes));
    if ((yield* io(() => storage.getItem(inquiryGuardKey))) !== bytes) {
      return yield* new InquiryGuardFailure({ reason: "storage" });
    }
    const outcome = yield* (ports.send ?? submitInquiry)(inquiry);
    if (outcome.state === "unconfirmed") {
      return outcome;
    }
    // Only decoded native ACK or the channel's typed pre-write refusal outcomes reach this branch.
    // Transport errors/unknown native dispatch are mapped to unconfirmed by submitInquiry.
    const cleared = yield* clearOwnMarker(storage, requestId).pipe(Effect.result);
    return Result.isFailure(cleared) && outcome.state !== "sent"
      ? { state: "unconfirmed" as const }
      : outcome;
  });

/** Browser Web Lock covers storage admission, dispatch and cleanup, including component unmount. */
export const submitGuardedInquiry = (
  fields: FormData,
  locale: string,
  product?: InquiryProduct,
  ports: InquiryGuardPorts = {},
): Effect.Effect<InquiryOutcome> =>
  Effect.gen(function* lockInquirySubmission() {
    const manager: CheckoutLockManager | null | undefined = yield* io(() =>
      ports.locks === undefined ? navigator.locks : ports.locks,
    );
    if (manager === undefined || manager === null) {
      return yield* new InquiryGuardFailure({ reason: "unsupported" });
    }
    const program = guardedSubmission(fields, locale, product, ports);
    const outcome = yield* Effect.tryPromise({
      catch: () => new InquiryGuardFailure({ reason: "storage" }),
      try: async () =>
        await manager.request<Exit.Exit<InquiryOutcome, Effect.Error<typeof program>>>(
          inquiryGuardKey,
          { ifAvailable: true, mode: "exclusive" },
          async (lock) =>
            lock === null
              ? Exit.fail(new InquiryGuardFailure({ reason: "busy" }))
              : await inquiryRuntime.runPromiseExit(program),
        ),
    });
    return yield* outcome;
  }).pipe(
    Effect.uninterruptible,
    Effect.match({
      onFailure: (error): InquiryOutcome =>
        Match.value(error).pipe(
          Match.tag("InquiryFailure", (): InquiryOutcome => ({ state: "invalid" })),
          Match.tag("InquiryGuardFailure", (failure): InquiryOutcome => ({
            state:
              failure.reason === "blocked" || failure.reason === "busy"
                ? "unconfirmed"
                : "unavailable",
          })),
          Match.exhaustive,
        ),
      onSuccess: (outcome) => outcome,
    }),
  );
