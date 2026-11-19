// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { customerConsentInput, isCustomerNewsletterConsent } from "@/ontos/consent-model";
import { GET, POST } from "@/app/api/ontos/account/consent/route";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const routePath = "/api/ontos/account/consent";
const contextPath = "/shell-super-app-api/auth/api-key/gateway-context";
const ownerBase = "/shell-super-app-api/commerce-customer-context";
const consentPath = "/api/portal-auth/customer-consent";
let network: Awaited<ReturnType<typeof serveHttp>>;
let ownerResponse: () => Response;

beforeEach(async () => {
  ownerResponse = () => Response.json({}, { status: 503 });
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === routePath) {
      const context = nextRequest(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === "POST" ? { body: await request.text() } : {}),
      });
      try {
        return await context.run(() =>
          request.method === "POST" ? POST(context.request) : GET(context.request),
        );
      } finally {
        await context.close();
      }
    }
    if (path === contextPath && request.method === "POST") {
      return Response.json({
        apiBaseUrl: ownerBase,
        compositionRevision: "a".repeat(64),
        token: "consent-owner-assertion",
        expiresAt: Date.now() + 60_000,
      });
    }
    if (path === `${ownerBase}${consentPath}`) return ownerResponse();
    return new Response("Not found", { status: 404 });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "customer-consent-test-key");
  vi.stubEnv("STOREFRONT_BRAND", "akros");
});
afterEach(async () => {
  try {
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

const ownerRequests = () =>
  network.requests.filter(
    (request) => new URL(request.url).pathname === `${ownerBase}${consentPath}`,
  );

const input = {
  decision: "GRANTED",
  noticeAcknowledged: true,
  noticeVersionId: "demo-newsletter.cs.v1",
  expectedRevision: 0,
  requestId: "33333333-3333-4333-8333-333333333333",
};
const projection = {
  decision: "ABSENT",
  revision: 0,
  notice: {
    language: "cs",
    noticeVersionId: input.noticeVersionId,
    wording: "Skutečné informace od vlastníka souhlasu.",
  },
};

describe("customer newsletter consent boundary", () => {
  it("permits only a choice with explicit acknowledgement and exact owner versions", () => {
    expect(customerConsentInput(input)).toEqual(input);
    expect(customerConsentInput({ ...input, decision: "WITHDRAWN" })).toEqual({
      ...input,
      decision: "WITHDRAWN",
    });
    expect(
      customerConsentInput({ ...input, decision: "WITHDRAWN", noticeAcknowledged: false }),
    ).toEqual({
      ...input,
      decision: "WITHDRAWN",
      noticeAcknowledged: false,
    });
    for (const malformed of [
      null,
      [],
      {},
      { ...input, decision: "ABSENT" },
      { ...input, decision: "REFUSED" },
      { ...input, noticeAcknowledged: false },
      { ...input, noticeAcknowledged: undefined },
      { ...input, noticeVersionId: "" },
      { ...input, expectedRevision: -1 },
      { ...input, expectedRevision: 0.5 },
      { ...input, expectedRevision: undefined },
      { ...input, requestId: "invalid" },
    ]) {
      expect(customerConsentInput(malformed)).toBeNull();
    }
  });
  it("never forwards browser-selected customer identities, authority or proof", () => {
    expect(
      customerConsentInput({
        ...input,
        partyId: "another-party",
        tenantId: "another-tenant",
        scope: { scopeRef: "another-scope" },
        actor: "privileged",
        sessionRef: "session",
        credentialRef: "credential",
        noticeEvidenceRefs: ["fabricated"],
        providerSubjectId: "another-account",
        proof: "fabricated",
      }),
    ).toEqual(input);
  });
  it("requires an actual complete owner projection instead of a consent default", () => {
    expect(isCustomerNewsletterConsent(projection)).toBe(true);
    for (const malformed of [
      undefined,
      null,
      {},
      { ...projection, decision: "UNKNOWN" },
      { ...projection, notice: { ...projection.notice, wording: " " } },
      { ...projection, notice: { ...projection.notice, noticeVersionId: "" } },
      { ...projection, revision: -1 },
      { ...projection, revision: undefined },
      { ...projection, notice: { ...projection.notice, language: "" } },
    ]) {
      expect(isCustomerNewsletterConsent(malformed)).toBe(false);
    }
  });
  it("rejects cross-origin or malformed input before requesting the owner", async () => {
    for (const origin of [undefined, "https://other.example", network.origin]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) headers.origin = origin;
      const response = await fetch(`${network.origin}${routePath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(origin === network.origin ? { partyId: "forged" } : input),
      });
      expect(response.status).toBe(origin === network.origin ? 400 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    await network.idle();
    expect(ownerRequests()).toEqual([]);
    expect(
      network.requests.filter((request) => new URL(request.url).pathname === contextPath),
    ).toEqual([]);
  });

  it("reads the current choice again after a transient owner outage", async () => {
    let reads = 0;
    ownerResponse = () => {
      reads += 1;
      return reads === 1 ? Response.json({}, { status: 503 }) : Response.json(projection);
    };
    const response = await fetch(`${network.origin}${routePath}`, {
      headers: { cookie: "commerce-portal.session_token=customer" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ consent: projection });
    await network.idle();
    expect(
      ownerRequests().map((request) => [
        new URL(request.url).pathname.slice(ownerBase.length),
        request.method,
      ]),
    ).toEqual([
      ["/api/portal-auth/customer-consent", "GET"],
      ["/api/portal-auth/customer-consent", "GET"],
    ]);
  });

  it("never repeats a choice after an owner outage", async () => {
    const origin = network.origin;
    const response = await fetch(`${origin}${routePath}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(503);
    await network.idle();
    expect(ownerRequests()).toHaveLength(1);
    expect(await ownerRequests()[0]?.json()).toEqual(input);
  });
});
