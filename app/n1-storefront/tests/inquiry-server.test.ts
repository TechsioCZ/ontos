import { beforeEach, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { readConfiguration } from "../src/ontos/config";
import type { StorefrontConfiguration } from "../src/ontos/config";
import { decodeInquiry } from "../src/ontos/inquiry";
import { persistInquiry } from "../src/ontos/inquiry-server";

rs.mock("../src/ontos/config", () => ({ readConfiguration: rs.fn() }));

const config = {
  apiKey: "inquiry-test-only-key",
  appId: "n1-storefront",
  legalEntityId: "71000000-0000-4000-8000-000000000099",
  shellUrl: "https://shell.example",
  tenantId: "71000000-0000-4000-8000-000000000098",
} satisfies StorefrontConfiguration;
const customer = {
  email: "shopper@example.test",
  locale: "en",
  message: "Please contact me about delivery.",
  name: "Shopper",
  phone: "",
  requestId: "71000000-0000-4000-8000-000000000097",
};
const actionPath = "/shell-super-app-api/gateway/work-tasks/actions/submit-storefront-inquiry";
const contextPath = "/shell-super-app-api/auth/api-key/gateway-context";
const firstKey = `n1-inquiry-${customer.requestId}`;
const accepted = (
  ref: { resourceId?: string; tenantId?: string } = {},
  requestId = customer.requestId,
) =>
  Response.json({
    requestId,
    taskRef: {
      moduleId: "work.tasks",
      resourceId: "confirmed-inquiry",
      resourceType: "work.tasks.task",
      tenantId: config.tenantId,
      ...ref,
    },
  });
const refused = (
  status: 403 | 409 | 503,
  problem: string,
  code: string,
  extra: Record<string, string | boolean> = {},
) =>
  Response.json(
    {
      _tag: `SubmitStorefrontInquiryAction${problem}Problem`,
      code,
      detail: "The Action was refused.",
      status,
      title: "Action refused",
      type: "https://ontos.dev/problems/action-refused",
      ...extra,
    },
    { status },
  );
const denied = () => refused(403, "Forbidden", "action_permission_denied");
const conflict = (code: string) => refused(409, "Conflict", code);
const alreadyCommitted = () =>
  refused(409, "AlreadyCommitted", "action_already_committed", {
    invocationId: "60000000-0000-4000-8000-000000000001",
    resolution: "REFRESH_GOVERNED_READS",
    retryCommand: false,
  });
const unavailable = () =>
  refused(503, "Unavailable", "work_persistence_unavailable", { retryable: true });

/** The Shell as the storefront key sees it: an assertion per write and the one admitted Work Tasks action. */
const backend = (...answers: readonly (() => Response)[]) => {
  const calls: Request[] = [];
  let assertions = 0;
  let writes = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path === contextPath) {
      assertions += 1;
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: `inquiry-test-only-assertion-${assertions}`,
      });
    }
    const answer = path === actionPath ? answers[writes] : undefined;
    if (answer === undefined) {
      throw new Error(`Unexpected inquiry transport call: ${path}`);
    }
    writes += 1;
    return answer();
  };
  return {
    fetch,
    paths: () => calls.map((call) => new URL(call.url).pathname),
    writes: () => calls.filter((call) => new URL(call.url).pathname === actionPath),
  };
};
const persist = (owner: ReturnType<typeof backend>, input: typeof customer = customer) =>
  decodeInquiry(input).pipe(
    Effect.flatMap(persistInquiry),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
  );

const wireBody = (call: Request | undefined) =>
  Effect.promise(async () => (call === undefined ? "" : await call.text()));

beforeEach(() => {
  rs.clearAllMocks();
  rs.mocked(readConfiguration).mockReturnValue(Effect.succeed(config));
});

it.effect("files the inquiry through the one admitted action with exactly its payload", () =>
  Effect.gen(function* committedInquiry() {
    const owner = backend(accepted);
    const result = yield* persist(owner, { ...customer, name: "  Shopper ", phone: " +420 1 " });
    expect(result).toEqual({ taskId: "confirmed-inquiry" });
    // No Work Tasks read precedes the write: the key is admitted on this action only.
    expect(owner.paths()).toEqual([contextPath, actionPath]);
    const [write] = owner.writes();
    expect(write?.method).toBe("POST");
    expect(write?.headers.get("authorization")).toBe("Bearer inquiry-test-only-assertion-1");
    expect(write?.headers.get("x-ontos-composition-revision")).toBe("a".repeat(64));
    expect(write?.headers.get("idempotency-key")).toBe(firstKey);
    expect(write?.headers.get("x-correlation-id")).toMatch(/^[\da-f-]{36}$/u);
    const sent: unknown = JSON.parse(yield* wireBody(write));
    // The owner refuses any other field (_tag, priority, command, expectedRevision) with a 400.
    expect(sent).toEqual({
      description:
        "Kontakt: Shopper <shopper@example.test>\nTelefon: +420 1\n\nPlease contact me about delivery.",
      storefrontInquiry: {
        email: customer.email,
        kind: "CONTACT",
        message: customer.message,
        name: "Shopper",
        requestId: customer.requestId,
        subject: "N1 contact inquiry",
      },
      title: "N1 contact inquiry",
    });
  }),
);

it.effect("reports a refused key as forbidden without another attempt", () =>
  Effect.gen(function* deniedInquiry() {
    const owner = backend(denied);
    const failure = yield* persist(owner).pipe(Effect.flip);
    expect(failure.reason).toBe("forbidden");
    expect(owner.paths()).toEqual([contextPath, actionPath]);
  }),
);

it.effect("does not resend a request id that already belongs to another submission", () =>
  Effect.gen(function* foreignRequestId() {
    const owner = backend(() => conflict("work_lifecycle_conflict"), accepted);
    const failure = yield* persist(owner).pipe(Effect.flip);
    expect(failure.reason).toBe("unconfirmed");
    expect(owner.writes()).toHaveLength(1);
  }),
);

for (const [name, first] of [
  ["an already committed key", alreadyCommitted],
  ["a first-task revision race", () => conflict("work_revision_conflict")],
] as const) {
  it.effect(`resends ${name} once under a new key with the same request id`, () =>
    Effect.gen(function* resentInquiry() {
      const owner = backend(first, () => accepted({ resourceId: "existing-inquiry" }));
      expect(yield* persist(owner)).toEqual({ taskId: "existing-inquiry" });
      // Assertions are single-use: the resend redeems its own.
      expect(owner.paths()).toEqual([contextPath, actionPath, contextPath, actionPath]);
      const [original, resent] = owner.writes();
      expect(original?.headers.get("idempotency-key")).toBe(firstKey);
      expect(resent?.headers.get("idempotency-key")).toMatch(
        new RegExp(`^${firstKey}-[\\da-f-]{36}$`, "u"),
      );
      expect(resent?.headers.get("authorization")).toBe("Bearer inquiry-test-only-assertion-2");
      const sent = yield* wireBody(original);
      expect(yield* wireBody(resent)).toBe(sent);
      expect(sent).toContain(`"requestId":"${customer.requestId}"`);
    }),
  );
}

for (const [name, answer, reason] of [
  // The owner refused both writes, so nothing was saved and the customer may send again.
  ["a repeated revision race", () => conflict("work_revision_conflict"), "unavailable"],
  // A task exists for this key but its reference could not be read back.
  ["a repeated already-committed answer", alreadyCommitted, "unconfirmed"],
] as const) {
  it.effect(`stops after the one resend of ${name}`, () =>
    Effect.gen(function* boundedResend() {
      const owner = backend(answer, answer, accepted);
      const failure = yield* persist(owner).pipe(Effect.flip);
      expect(failure.reason).toBe(reason);
      expect(owner.writes()).toHaveLength(2);
    }),
  );
}

it.effect("never claims non-delivery when the resend of a committed key fails", () =>
  Effect.gen(function* committedThenDenied() {
    const owner = backend(alreadyCommitted, denied);
    const failure = yield* persist(owner).pipe(Effect.flip);
    expect(failure.reason).toBe("unconfirmed");
    expect(owner.writes()).toHaveLength(2);
  }),
);

for (const [name, answer] of [
  ["an unavailable owner", unavailable],
  ["a receipt for another tenant", () => accepted({ tenantId: config.legalEntityId })],
  ["a receipt for another request", () => accepted({}, "71000000-0000-4000-8000-000000000001")],
  ["a receipt without a task id", () => accepted({ resourceId: "" })],
  [
    "an approval proposal instead of a saved task",
    () =>
      Response.json(
        {
          _tag: "ActionProposalAccepted",
          expiresAt: "2026-11-08T12:00:00.000Z",
          proposalId: "60000000-0000-4000-8000-000000000001",
        },
        { status: 202 },
      ),
  ],
] as const) {
  it.effect(`keeps ${name} unconfirmed without retrying or inventing a saved task`, () =>
    Effect.gen(function* unconfirmedInquiry() {
      const owner = backend(answer, accepted);
      const failure = yield* persist(owner).pipe(Effect.flip);
      expect(failure.reason).toBe("unconfirmed");
      expect(failure).not.toHaveProperty("taskId");
      expect(owner.writes()).toHaveLength(1);
    }),
  );
}
