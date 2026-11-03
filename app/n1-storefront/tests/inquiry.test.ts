import { Effect, Match } from "effect";
import type { InquiryOutcome } from "../src/ontos/inquiry";
import type { InquirySubmissionRef } from "../src/ontos/inquiry-client";
import { inquiryRuntime, startInquirySubmission } from "../src/ontos/inquiry-client";
import { describe, expect, it } from "effect-rstest";
import {
  confirmInquiryTask,
  decodeInquiry,
  InquiryFailure,
  isInquiryOrigin,
  makeInquiryCommand,
  sendInquiry,
} from "../src/ontos/inquiry-model";

const customer = {
  email: "shopper@example.com",
  locale: "en",
  message: "Please contact me about delivery.",
  name: "Shopper",
  phone: "+420123456789",
  requestId: "71000000-0000-4000-8000-000000000099",
};
describe("N1 contact owner integration", () => {
  it.effect("rejects invalid customer input before reaching the owner", () =>
    Effect.gen(function* invalidInput() {
      const failure = yield* Effect.flip(decodeInquiry({ ...customer, email: "not-email" }));
      expect(failure.reason).toBe("invalid");
    }),
  );
  it.effect("keeps caller identity fields out of the command and retains the optional phone", () =>
    Effect.gen(function* customerFieldsOnly() {
      const input = yield* decodeInquiry({
        ...customer,
        subject: "attacker",
        tenantId: "attacker",
        title: "attacker",
      });
      const payload = yield* makeInquiryCommand(input, 3);
      expect(payload.expectedRevision).toBe(3);
      const command = Match.value(payload.command).pipe(
        Match.tag("CreateTask", (value) => value),
        Match.orElse(() => null),
      );
      expect(command?.title).toBe("N1 contact inquiry");
      expect(command?.description).toContain("Telefon: +420123456789");
      expect(command?.storefrontInquiry?.requestId).toBe(customer.requestId);
      expect(payload).not.toHaveProperty("tenantId");
    }),
  );
  it.effect("never retries an unknown write outcome", () =>
    Effect.gen(function* uncertainWrite() {
      const input = yield* decodeInquiry(customer);
      let writes = 0;
      const failure = yield* Effect.flip(
        sendInquiry(input, {
          apply: () =>
            Effect.sync(() => {
              writes += 1;
            }).pipe(Effect.andThen(Effect.fail(new InquiryFailure({ reason: "unconfirmed" })))),
          revision: Effect.succeed(4),
        }),
      );
      expect(failure.reason).toBe("unconfirmed");
      expect(writes).toBe(1);
    }),
  );
  it.effect("retries a definite revision refusal with a fresh revision", () =>
    Effect.gen(function* revisionConflict() {
      const input = yield* decodeInquiry(customer);
      let revision = 4;
      const attempts: number[] = [];
      const requestIds: string[] = [];
      const receipt = yield* sendInquiry(input, {
        apply: (payload) => {
          attempts.push(payload.expectedRevision);
          const requestId = Match.value(payload.command).pipe(
            Match.tag("CreateTask", (command) => command.storefrontInquiry?.requestId),
            Match.orElse(() => null),
          );
          requestIds.push(requestId ?? "");
          return attempts.length === 1
            ? Effect.fail(new InquiryFailure({ reason: "conflict" }))
            : Effect.succeed("task-confirmed");
        },
        revision: Effect.sync(() => {
          const current = revision;
          revision += 1;
          return current;
        }),
      });
      expect(receipt.taskId).toBe("task-confirmed");
      expect(attempts).toEqual([4, 5]);
      expect(requestIds).toEqual([customer.requestId, customer.requestId]);
    }),
  );
  it.effect("does not attempt a write when the owner read is forbidden", () =>
    Effect.gen(function* forbiddenRead() {
      const input = yield* decodeInquiry(customer);
      let writes = 0;
      const failure = yield* Effect.flip(
        sendInquiry(input, {
          apply: () =>
            Effect.sync(() => {
              writes += 1;
              return "unexpected";
            }),
          revision: Effect.fail(new InquiryFailure({ reason: "forbidden" })),
        }),
      );
      expect(failure.reason).toBe("forbidden");
      expect(writes).toBe(0);
    }),
  );
});

for (const result of [
  {},
  {
    task: {
      ref: { resourceId: "task-1", tenantId: "other-tenant" },
      storefrontInquiry: { requestId: customer.requestId },
    },
  },
  {
    task: {
      ref: { resourceId: "task-1", tenantId: "n1" },
      storefrontInquiry: { requestId: "other-request" },
    },
  },
]) {
  it.effect("requires a matching owner receipt", () =>
    Effect.gen(function* verifiesReceipt() {
      const failure = yield* Effect.flip(confirmInquiryTask(result, "n1", customer.requestId));
      expect(failure.reason).toBe("unconfirmed");
    }),
  );
}

it("requires the same complete origin", () => {
  expect(isInquiryOrigin("https://n1.example", "https://n1.example/api/inquiries")).toBe(true);
  expect(isInquiryOrigin("http://n1.example", "https://n1.example/api/inquiries")).toBe(false);
  expect(isInquiryOrigin("https://n1.example:8443", "https://n1.example/api/inquiries")).toBe(
    false,
  );
  expect(isInquiryOrigin(undefined, "https://n1.example/api/inquiries")).toBe(false);
  expect(isInquiryOrigin("not a URL", "https://n1.example/api/inquiries")).toBe(false);
});

it.effect("confirms the matching persisted task", () =>
  Effect.gen(function* confirmsSavedTask() {
    const taskId = yield* confirmInquiryTask(
      {
        task: {
          ref: { resourceId: "saved-task", tenantId: "n1" },
          storefrontInquiry: { requestId: customer.requestId },
        },
      },
      "n1",
      customer.requestId,
    );
    expect(taskId).toBe("saved-task");
  }),
);

it.effect(
  "allows a valid retry after warmed-runtime whitespace validation finishes synchronously",
  () =>
    Effect.gen(function* synchronousValidationRetry() {
      yield* Effect.promise(async () => await inquiryRuntime.runPromise(Effect.void));
      const active: InquirySubmissionRef = { current: null };
      const outcomes: InquiryOutcome["state"][] = [];
      let submissions = 0;
      const onOutcome = (outcome: InquiryOutcome) => {
        outcomes.push(outcome.state);
      };
      const program = (name: string) =>
        decodeInquiry({ ...customer, name }).pipe(
          Effect.flatMap(() =>
            Effect.sync((): InquiryOutcome => {
              submissions += 1;
              return { state: "unavailable" };
            }),
          ),
          Effect.catchTag("InquiryFailure", () =>
            Effect.succeed<InquiryOutcome>({ state: "invalid" }),
          ),
        );
      startInquirySubmission(active, onOutcome, program("   "));
      expect(active.current).toBeNull();
      expect(outcomes).toEqual(["invalid"]);
      expect(submissions).toBe(0);
      startInquirySubmission(active, onOutcome, program("Shopper"));
      expect(active.current).toBeNull();
      expect(outcomes).toEqual(["invalid", "unavailable"]);
      expect(submissions).toBe(1);
    }),
);
