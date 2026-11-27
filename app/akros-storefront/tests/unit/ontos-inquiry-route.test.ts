import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/inquiries/route";
import { readProducts } from "@/ontos/catalog-server";
import { parseInquirySubmission, type InquirySubmission } from "@/ontos/inquiry-model";
import { browserAt, serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const inquiry = {
  requestId: "a1234567-1234-4234-8234-123456789abc",
  kind: "CONTACT",
  name: "Zákazník",
  email: "customer@example.test",
  subject: "Dostupnost materiálu",
  message: "Prosím o ověření dostupnosti.",
};
const submissionKey = expect.stringMatching(
  new RegExp(`^sf-inquiry-${inquiry.requestId}-[\\da-f-]{36}$`, "u"),
);
const accepted = (resourceId = "persisted-task", requestId = inquiry.requestId) => ({
  requestId,
  taskRef: {
    moduleId: "work.tasks",
    resourceId,
    resourceType: "work.tasks.task",
    tenantId: "tenant",
  },
});
const gatewayContextPath = "/shell-super-app-api/auth/api-key/gateway-context";
const gatewayReadPath = "/shell-super-app-api/auth/api-key/gateway-read";
const ownerBase = "/shell-super-app-api/inquiry-test";
const actionPath = `${ownerBase}/work-tasks/actions/submit-storefront-inquiry`;
const legalEntityId = "71000000-0000-4000-8000-000000000024";
const revision = "a".repeat(64);
let network: Awaited<ReturnType<typeof serveHttp>>;
let actionResponses: Array<{ status: number; body: unknown }>;
let actionCalls: Array<[string, string, unknown, string | null]>;
let answerAction: ((payload: unknown, key: string | null) => Response) | undefined;
let recordReads: unknown[];
let catalogReads: unknown[];
let previousUrl: string;
let httpFailures: unknown[];
let products: Array<{ id: string; slug: string; name: string }>;
const refused = (status: number, code?: string) => ({ status, body: { code } });

const submitIn = async (locale: string | undefined, body: object = inquiry) => {
  const response = await fetch(`${network.origin}/api/ontos/inquiries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(locale === undefined ? {} : { "x-akros-market-locale": locale }),
    },
    body: JSON.stringify(body),
  });
  // The route response is the arrival signal; idle closes the count/negative assertion window.
  await network.idle();
  return response;
};
const submit = (body: object = inquiry) => submitIn("cs", body);

beforeEach(async () => {
  previousUrl = window.location.href;
  httpFailures = [];
  actionResponses = [{ status: 200, body: accepted() }];
  actionCalls = [];
  answerAction = undefined;
  recordReads = [];
  catalogReads = [];
  products = [];
  const tokens = new Set<string>();
  let issued = 0;
  network = await serveHttp(async (request) => {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/api/ontos/inquiries") {
        const context = nextRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
        });
        try {
          return await context.run(() => POST(context.request));
        } finally {
          await context.close();
        }
      }
      if (path === gatewayContextPath || path === gatewayReadPath) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-api-key")).toBe("inquiry-test-key");
        const body = await request.json();
        expect(body.legalEntityId).toBe(legalEntityId);
        const context = {
          apiBaseUrl: ownerBase,
          compositionRevision: revision,
          token: `inquiry-assertion-${++issued}`,
          expiresAt: Date.now() + 60_000,
        };
        if (path === gatewayContextPath) {
          expect(body).toEqual({ audience: "work-tasks", legalEntityId });
          tokens.add(context.token);
          return Response.json(context);
        }
        recordReads.push(body);
        const headers = { "x-ontos-gateway-context": JSON.stringify(context) };
        if (body.audience === "commerce-market-catalog") {
          expect(body.readName).toBe("current-market-catalog");
          return Response.json({ markets: [], associations: [] }, { headers });
        }
        expect(body.audience).toBe("merchandise");
        expect(body.readName).toBe("records");
        catalogReads.push(body.query);
        return Response.json({ products, total: products.length }, { headers });
      }
      if (path === actionPath) {
        expect(request.method).toBe("POST");
        const token = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
        expect(tokens.delete(token)).toBe(true);
        expect(request.headers.get("x-ontos-composition-revision")).toBe(revision);
        const [, vertical, , slug] = path.slice(ownerBase.length).split("/");
        actionCalls.push([
          vertical,
          slug,
          await request.json(),
          request.headers.get("idempotency-key"),
        ]);
        if (answerAction !== undefined) {
          const call = actionCalls.at(-1);
          return answerAction(call?.[2], request.headers.get("idempotency-key"));
        }
        const answer =
          actionResponses[Math.min(actionCalls.length - 1, actionResponses.length - 1)];
        return Response.json(answer.body, { status: answer.status });
      }
      throw new Error(`Unexpected HTTP request: ${request.method} ${path}`);
    } catch (error) {
      httpFailures.push(error);
      throw error;
    }
  });
  browserAt(network.origin);
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "inquiry-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "akros-storefront");
});
afterEach(async () => {
  try {
    await network.idle();
    await network.close();
    expect(httpFailures).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    browserAt(previousUrl);
  }
});
describe("persisted storefront inquiries", () => {
  it("files the inquiry through the narrow Work Tasks action with exactly its payload", async () => {
    const response = await submit({ ...inquiry, name: "  Zákazník ", priority: "URGENT" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: "persisted-task" });
    expect(actionCalls).toEqual([
      [
        "work-tasks",
        "submit-storefront-inquiry",
        {
          title: "Kontaktní dotaz: Dostupnost materiálu",
          description: "Kontakt: Zákazník <customer@example.test>\n\nProsím o ověření dostupnosti.",
          storefrontInquiry: inquiry,
        },
        submissionKey,
      ],
    ]);
    // The storefront key is admitted on this one action only: no Work Tasks read precedes it.
    expect(recordReads).toEqual([]);
  });
  it("shows the unavailable form after an authorization denial, without another attempt", async () => {
    actionResponses = [refused(403, "action_permission_denied")];
    const response = await submit();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).message).toContain(
      "Kontaktní formulář je dočasně nedostupný. Dotaz nebyl odeslán.",
    );
    expect(actionCalls).toHaveLength(1);
  });
  it("never replays an unknown action outcome or claims definite non-delivery", async () => {
    actionResponses = [refused(503)];
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
    expect(actionCalls).toHaveLength(1);
  });
  it("does not resend a request id that already belongs to another submission", async () => {
    actionResponses = [refused(409, "work_lifecycle_conflict")];
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
    expect(actionCalls).toHaveLength(1);
  });
  it.each(["action_already_committed", "work_revision_conflict"])(
    "does not replay %s under a new key or claim definite non-delivery",
    async (code) => {
      actionResponses = [refused(409, code), { status: 200, body: accepted("existing-task") }];
      const response = await submit();
      expect(response.status).toBe(503);
      const { message } = await response.json();
      expect(message).toContain("nepodařilo potvrdit");
      expect(message).not.toContain("nebyl odeslán");
      expect(actionCalls).toHaveLength(1);
      expect(actionCalls[0]?.[3]).toEqual(submissionKey);
      expect(actionCalls[0]?.[2]).toMatchObject({
        storefrontInquiry: { requestId: inquiry.requestId },
      });
    },
  );
  it("recovers a lost committed receipt on explicit resend without creating another inquiry", async () => {
    const committedKeys = new Set<string | null>();
    const tasks = new Map<
      string,
      { submission: InquirySubmission; receipt: ReturnType<typeof accepted> }
    >();
    // Model the two owner boundaries separately: Action keys cannot replay a commit, but the
    // Work Tasks owner returns the existing task for the same request id and customer fields.
    answerAction = (payload, key) => {
      if (committedKeys.has(key))
        return Response.json({ code: "action_already_committed" }, { status: 409 });
      const submission = parseInquirySubmission(
        payload !== null && typeof payload === "object" && "storefrontInquiry" in payload
          ? payload.storefrontInquiry
          : null,
      );
      if (submission === null) throw new Error("Invalid inquiry reached the owner");
      const existing = tasks.get(submission.requestId);
      if (existing !== undefined) {
        if (JSON.stringify(existing.submission) !== JSON.stringify(submission))
          return Response.json({ code: "work_lifecycle_conflict" }, { status: 409 });
        committedKeys.add(key);
        return Response.json(existing.receipt);
      }
      tasks.set(submission.requestId, {
        submission,
        receipt: accepted("existing-task", submission.requestId),
      });
      committedKeys.add(key);
      // The owner committed, but its acknowledgement was truncated before it reached AKROS.
      return new Response('{"requestId":', {
        headers: { "content-type": "application/json" },
      });
    };
    const uncertain = await submit();
    expect(uncertain.status).toBe(503);
    expect((await uncertain.json()).message).toContain("nepodařilo potvrdit");
    expect(actionCalls).toHaveLength(1);
    expect(tasks.size).toBe(1);
    const retried = await submit();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ taskId: "existing-task" });
    expect(actionCalls).toHaveLength(2);
    expect(actionCalls[1]?.slice(0, 3)).toEqual(actionCalls[0]?.slice(0, 3));
    expect(actionCalls[0]?.[3]).toEqual(submissionKey);
    expect(actionCalls[1]?.[3]).toEqual(submissionKey);
    expect(actionCalls[1]?.[3]).not.toBe(actionCalls[0]?.[3]);
    expect(tasks.size).toBe(1);
    expect(recordReads).toEqual([]);

    const changed = await submit({ ...inquiry, message: "Jiný dotaz pod stejným ID." });
    expect(changed.status).toBe(503);
    expect((await changed.json()).message).toContain("nepodařilo potvrdit");
    expect(actionCalls).toHaveLength(3);
    expect(tasks.size).toBe(1);
    expect(tasks.get(inquiry.requestId)?.submission).toEqual(inquiry);
  });
  it.each([
    ["no task reference", { requestId: inquiry.requestId }],
    ["an empty task id", accepted("")],
    ["another request id", accepted("persisted-task", "b1234567-1234-4234-8234-123456789abc")],
    ["the old apply-command shape", { task: { ref: { resourceId: "persisted-task" } } }],
  ])("does not confirm an acknowledgement with %s", async (_label, result) => {
    actionResponses = [{ status: 200, body: result }];
    const response = await submit();
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("nepodařilo potvrdit");
  });
  it("uses fresh owner product identity instead of caller labels", async () => {
    // Prime the real cache, then change the served owner data: the route must read fresh.
    products = [{ id: "p1", slug: "stale-slug", name: "Stale product" }];
    const context = nextRequest(`${network.origin}/cs`, {
      headers: { "x-akros-market-locale": "cs" },
    });
    try {
      await context.run(() => readProducts({ productIds: ["p1"], pageSize: 1 }, "card"));
    } finally {
      await context.close();
    }
    products = [{ id: "p1", slug: "owner-slug", name: "Owner product" }];
    const response = await submit({
      ...inquiry,
      kind: "PRODUCT_QUESTION",
      productId: "p1",
      productName: "Forged",
    });
    expect(response.status).toBe(200);
    const ownerQuery = {
      view: {
        storefront: true,
        storefrontCatalog: {
          storefrontAppId: "akros-storefront",
          productIds: ["p1"],
          pageSize: 1,
          fields: "card",
          includeCategories: false,
        },
      },
    };
    // The shared read checks the catalogue revision first; the inquiry's own read is fresh and checks none.
    const revisionQuery = {
      view: {
        storefront: true,
        storefrontCatalog: {
          storefrontAppId: "akros-storefront",
          mode: "categories",
          includeCategories: false,
        },
      },
    };
    expect(catalogReads).toEqual([revisionQuery, ownerQuery, ownerQuery]);
    expect(actionCalls[0]?.[2]).toEqual({
      title: "Dotaz na produkt: Dostupnost materiálu",
      description:
        "Kontakt: Zákazník <customer@example.test>\nProdukt: Owner product\n\nProsím o ověření dostupnosti.",
      storefrontInquiry: {
        ...inquiry,
        kind: "PRODUCT_QUESTION",
        productId: "p1",
        productName: "Owner product",
        productSlug: "owner-slug",
      },
    });
  });
  it("refuses a task text beyond the owner's limit as invalid input instead of clipping it", async () => {
    products = [{ id: "p1", slug: "owner-slug", name: "P".repeat(200) }];
    const response = await submit({
      ...inquiry,
      kind: "PRODUCT_QUESTION",
      productId: "p1",
      name: "N".repeat(120),
      email: `${"e".repeat(242)}@example.cz`,
      message: "m".repeat(1500),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Zkontrolujte jméno, e-mail, předmět a zprávu (nejvýše 1 500 znaků).",
    });
    expect(actionCalls).toHaveLength(0);
  });
});

describe("inquiry messages follow the market language", () => {
  it.each([
    [undefined, "Zkontrolujte jméno, e-mail, předmět a zprávu (nejvýše 1 500 znaků)."],
    ["sk", "Skontrolujte meno, e-mail, predmet a správu (najviac 1 500 znakov)."],
    ["en", "Check your name, e-mail, subject and message (at most 1,500 characters)."],
  ])("refuses an invalid inquiry for locale %s", async (locale, message) => {
    const response = await submitIn(locale, { ...inquiry, email: "nope" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
    expect(actionCalls).toHaveLength(0);
  });
  it.each([
    ["sk", "Dopyt nebol odoslaný"],
    ["en", "Your enquiry was not sent"],
  ])("words the unavailable form for locale %s", async (locale, text) => {
    actionResponses = [refused(403, "action_permission_denied")];
    const response = await submitIn(locale);
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain(text);
  });
  it.each([
    ["sk", "Prijatie dopytu sa nepodarilo potvrdiť."],
    ["en", "We could not confirm that your enquiry was received."],
  ])("words an unconfirmed outcome for locale %s", async (locale, text) => {
    actionResponses = [refused(503)];
    const response = await submitIn(locale);
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain(text);
  });
});
