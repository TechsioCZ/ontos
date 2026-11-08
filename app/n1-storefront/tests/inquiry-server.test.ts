import { beforeEach, expect, rs } from "@rstest/core";
import { it } from "effect-rstest";
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ApplyCommandPayloadSchema } from "@app/work-tasks/contracts/apply-command";
import type { RecordsResponseSchema } from "@app/work-tasks/contracts/records";
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
const collection = {
  properties: {
    dueDate: { locked: true, type: "DATE" },
    ownerPrincipalRef: { locked: true, type: "PRINCIPAL" },
    status: { groups: ["NOT_STARTED", "IN_PROGRESS", "DONE"], locked: true, type: "STATUS" },
    title: { locked: true, type: "TEXT" },
  },
  ref: {
    moduleId: "work.tasks",
    resourceId: "inquiries",
    resourceType: "work.tasks.task-collection",
    tenantId: config.tenantId,
  },
  title: "Inquiries",
} as const;
const snapshot = {
  actorPrincipalRef: {
    principalId: "71000000-0000-4000-8000-000000000096",
    tenantId: config.tenantId,
  },
  assignablePrincipals: [],
  canWrite: true,
  collection,
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  principalNames: [],
  referenceDate: "2026-11-07",
  revision: 4,
} satisfies typeof RecordsResponseSchema.Encoded;
const backend = (outcome: "committed" | "proposal" | "proposal-with-task") => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path.endsWith("/gateway-read")) {
      return Response.json(snapshot);
    }
    if (path.endsWith("/gateway-context")) {
      return Response.json({
        apiBaseUrl: "/shell-super-app-api/gateway",
        compositionRevision: "a".repeat(64),
        expiresAt: 9_999_999_999,
        token: "inquiry-test-only-assertion",
      });
    }
    if (path.endsWith("/actions/apply-command")) {
      const payload = Schema.decodeUnknownSync(ApplyCommandPayloadSchema)(await request.json());
      if (payload.command._tag !== "CreateTask") {
        throw new Error("Expected the actual inquiry CreateTask command");
      }
      const task = {
        collectionRef: collection.ref,
        contextRefs: [],
        createdAt: "2026-11-07T12:00:00.000Z",
        priority: "NORMAL",
        ref: {
          moduleId: "work.tasks",
          resourceId: "confirmed-inquiry",
          resourceType: "work.tasks.task",
          tenantId: config.tenantId,
        },
        state: "NEW",
        storefrontInquiry: payload.command.storefrontInquiry,
        title: payload.command.title,
        updatedAt: "2026-11-07T12:00:00.000Z",
      };
      if (outcome === "committed") {
        return Response.json({ revision: 5, task });
      }
      const proposal = {
        _tag: "ActionProposalAccepted",
        expiresAt: "2026-11-08T12:00:00.000Z",
        proposalId: "60000000-0000-4000-8000-000000000001",
      };
      const response =
        outcome === "proposal-with-task" ? { ...proposal, revision: 5, task } : proposal;
      return Response.json(response, { status: 202 });
    }
    throw new Error(`Unexpected inquiry transport path: ${path}`);
  };
  return { calls, fetch };
};

beforeEach(() => {
  rs.clearAllMocks();
  rs.mocked(readConfiguration).mockReturnValue(Effect.succeed(config));
});

it.effect("confirms only the committed native owner response for this inquiry", () =>
  Effect.gen(function* committedInquiry() {
    const owner = backend("committed");
    const inquiry = yield* decodeInquiry(customer);
    const result = yield* persistInquiry(inquiry).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
    );
    expect(result).toEqual({ taskId: "confirmed-inquiry" });
    expect(owner.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/shell-super-app-api/auth/api-key/gateway-read",
      "/shell-super-app-api/auth/api-key/gateway-context",
      "/shell-super-app-api/gateway/work-tasks/actions/apply-command",
    ]);
  }),
);

for (const outcome of ["proposal", "proposal-with-task"] as const) {
  it.effect(`keeps ${outcome} unconfirmed without retrying or inventing a saved task`, () =>
    Effect.gen(function* pendingInquiry() {
      const owner = backend(outcome);
      const inquiry = yield* decodeInquiry(customer);
      const failure = yield* persistInquiry(inquiry).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, owner.fetch),
        Effect.flip,
      );
      expect(failure.reason).toBe("unconfirmed");
      expect(failure).not.toHaveProperty("taskId");
      expect(owner.calls).toHaveLength(3);
    }),
  );
}
