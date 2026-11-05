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
  resolveInquiryProduct,
} from "../src/ontos/inquiry-model";
import { projectCatalog } from "../src/ontos/catalog-model";
import { inquiryMessageMaximum, parseInquiryProductQuery } from "../src/ontos/inquiry";

const customer = {
  email: "shopper@example.com",
  locale: "en",
  message: "Please contact me about delivery.",
  name: "Shopper",
  phone: "+420123456789",
  requestId: "71000000-0000-4000-8000-000000000099",
};
const questionCatalog = projectCatalog(
  {
    market: { configured: true, currency: "CZK", marketId: "n1-market" },
    products: [
      {
        id: "product",
        name: "Actual owner product",
        slug: "actual-owner-product",
        variantRecords: [true, false].map((active) => ({
          active,
          attributes: "",
          availability: "OUT_OF_STOCK",
          grossPriceMinor: 0,
          id: active ? "n1legacy:variant:12" : "inactive-variant",
          name: active ? "M" : "S",
          sku: active ? "ACTUAL-M" : "ACTUAL-S",
          stockOnHand: 0,
        })),
      },
    ],
  },
  [],
);

describe("N1 canonical product questions", () => {
  it("keeps the exact single selected legacy variant in the contact URL", () => {
    expect(
      parseInquiryProductQuery({ productId: "product", variantIds: "n1legacy:variant:12" }),
    ).toEqual({
      selector: { productId: "product", variantIds: ["n1legacy:variant:12"] },
      state: "product",
    });
    expect(parseInquiryProductQuery({})).toEqual({ state: "none" });
    expect(parseInquiryProductQuery({ productId: "product" })).toEqual({
      selector: { productId: "product", variantIds: [] },
      state: "product",
    });
  });
  it.each([
    { productId: "" },
    { productId: ["product", "other"] },
    { variantIds: "variant" },
    { productId: "product", variantIds: ["variant"] },
    { productId: "product", variantIds: "first,second" },
    { productId: "product", variantIds: "" },
    { productId: "p".repeat(301) },
  ])("rejects ambiguous or incomplete URL selectors", (query) => {
    expect(parseInquiryProductQuery(query)).toEqual({ state: "invalid" });
  });
  it.effect(
    "resolves an out-of-stock legacy variant and ignores client presentation metadata",
    () =>
      Effect.gen(function* canonicalProductQuestion() {
        const input = yield* decodeInquiry({
          ...customer,
          product: {
            kind: "CONTACT",
            productId: "product",
            productName: "Forged product",
            productSlug: "forged-slug",
            variantIds: ["n1legacy:variant:12"],
          },
        });
        expect(input.product).toEqual({
          productId: "product",
          variantIds: ["n1legacy:variant:12"],
        });
        if (input.product === undefined) {
          throw new Error("Expected the decoded product selector");
        }
        const context = yield* resolveInquiryProduct(input.product, questionCatalog.details);
        const payload = yield* makeInquiryCommand(input, 12, context);
        const command = Match.value(payload.command).pipe(
          Match.tag("CreateTask", (value) => value),
          Match.orElse(() => null),
        );
        expect(command?.storefrontInquiry).toMatchObject({
          kind: "PRODUCT_QUESTION",
          message: customer.message,
          productId: "product",
          productName: "Actual owner product",
          productSlug: "actual-owner-product",
          requestId: customer.requestId,
        });
        expect(command?.description).toContain("Variant: M (ACTUAL-M) [n1legacy:variant:12]");
        expect(command?.description).not.toContain("Forged product");
        expect(command?.storefrontInquiry).not.toHaveProperty("variantIds");
      }),
  );
  for (const selector of [
    { productId: "foreign-product", variantIds: [] },
    { productId: "product", variantIds: ["foreign-variant"] },
    { productId: "product", variantIds: ["inactive-variant"] },
    { productId: "product", variantIds: ["n1legacy:variant:12", "inactive-variant"] },
  ]) {
    it.effect(
      "rejects unavailable product/variant identities without silently dropping selection",
      () =>
        Effect.gen(function* invalidProductIdentity() {
          const failure = yield* Effect.flip(
            resolveInquiryProduct(selector, questionCatalog.details),
          );
          expect(failure.reason).toBe("invalid");
        }),
    );
  }
  it.effect("allows a general product question without auto-selecting its first variant", () =>
    Effect.gen(function* unselectedProductQuestion() {
      const context = yield* resolveInquiryProduct(
        { productId: "product", variantIds: [] },
        questionCatalog.details,
      );
      expect(context).not.toHaveProperty("variant");
      const input = yield* decodeInquiry({
        ...customer,
        product: { productId: "product", variantIds: [] },
      });
      const payload = yield* makeInquiryCommand(input, 2, context);
      expect(payload.command).toMatchObject({
        storefrontInquiry: { kind: "PRODUCT_QUESTION", productId: "product" },
      });
    }),
  );
  it.effect("does not reach Work Tasks when the current public product read is unavailable", () =>
    Effect.gen(function* unavailableProductRead() {
      const input = yield* decodeInquiry({
        ...customer,
        product: { productId: "product", variantIds: [] },
      });
      let reads = 0;
      let writes = 0;
      const failure = yield* Effect.flip(
        sendInquiry(input, {
          apply: () =>
            Effect.sync(() => {
              writes += 1;
              return "unexpected";
            }),
          product: () => Effect.fail(new InquiryFailure({ reason: "unavailable" })),
          revision: Effect.sync(() => {
            reads += 1;
            return 1;
          }),
        }),
      );
      expect(failure.reason).toBe("unavailable");
      expect(reads).toBe(0);
      expect(writes).toBe(0);
    }),
  );
  it.effect("reserves the native description budget and never truncates a customer's message", () =>
    Effect.gen(function* nativeDescriptionBudget() {
      const context = {
        productId: "product",
        productName: "Actual",
        productSlug: "actual",
        variant: {
          id: "v".repeat(300),
          name: "M".repeat(300),
          sku: "S".repeat(300),
        },
      };
      const limit = inquiryMessageMaximum(context, "en");
      const input = yield* decodeInquiry({
        ...customer,
        email: `${"e".repeat(243)}@example.cz`,
        message: "m".repeat(limit),
        name: "N".repeat(120),
        phone: "p".repeat(40),
        product: { productId: "product", variantIds: [context.variant.id] },
      });
      const payload = yield* makeInquiryCommand(input, 1, context);
      const command = Match.value(payload.command).pipe(
        Match.tag("CreateTask", (value) => value),
        Match.orElse(() => null),
      );
      expect(command?.description?.length).toBeLessThanOrEqual(2000);
      expect(command?.storefrontInquiry?.message).toBe(input.message);
      const failure = yield* Effect.flip(
        makeInquiryCommand({ ...input, message: `${input.message}m` }, 1, context),
      );
      expect(failure.reason).toBe("invalid");
    }),
  );
  it.effect(
    "rejects mismatched canonical context rather than attaching the message to another product",
    () =>
      Effect.gen(function* mismatchedProductContext() {
        const input = yield* decodeInquiry({
          ...customer,
          product: { productId: "product", variantIds: [] },
        });
        const failure = yield* Effect.flip(
          makeInquiryCommand(input, 1, {
            productId: "other",
            productName: "Other",
            productSlug: "other",
          }),
        );
        expect(failure.reason).toBe("invalid");
      }),
  );
});
describe("N1 contact owner integration", () => {
  it.effect("rejects a malformed product question instead of silently sending a contact task", () =>
    Effect.gen(function* malformedProductQuestion() {
      const failure = yield* Effect.flip(
        decodeInquiry({ ...customer, product: { productId: "", variantIds: [] } }),
      );
      expect(failure.reason).toBe("invalid");
    }),
  );
  it.effect("requires canonical product resolution before reading or writing the task owner", () =>
    Effect.gen(function* productResolutionRequired() {
      const input = yield* decodeInquiry({
        ...customer,
        product: { productId: "product", variantIds: ["variant"] },
      });
      let writes = 0;
      let reads = 0;
      const outcome = yield* sendInquiry(input, {
        apply: () =>
          Effect.sync(() => {
            writes += 1;
            return "unexpected";
          }),
        revision: Effect.sync(() => {
          reads += 1;
          return 4;
        }),
      }).pipe(Effect.result);
      expect(writes).toBe(0);
      expect(reads).toBe(0);
      expect(outcome._tag).toBe("Failure");
    }),
  );
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
