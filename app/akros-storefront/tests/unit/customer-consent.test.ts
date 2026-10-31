import { beforeEach, describe, expect, it, vi } from "vitest";
import { customerConsentInput, isCustomerNewsletterConsent } from "@/ontos/consent-model";
import { GET, POST } from "@/app/api/ontos/account/consent/route";
import { ownerRequest } from "@/ontos/gateway";

vi.mock("@/ontos/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ontos/gateway")>()),
  ownerRequest: vi.fn<typeof ownerRequest>(),
}));
beforeEach(() => vi.resetAllMocks());

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
    for (const origin of [undefined, "https://other.example", "http://localhost:3070"]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) headers.origin = origin;
      const response = await POST(
        new Request("http://localhost:3070/api/ontos/account/consent", {
          method: "POST",
          headers,
          body: JSON.stringify(origin === "http://localhost:3070" ? { partyId: "forged" } : input),
        }),
      );
      expect(response.status).toBe(origin === "http://localhost:3070" ? 400 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(ownerRequest).not.toHaveBeenCalled();
  });

  it("reads the current choice again after a transient owner outage", async () => {
    vi.mocked(ownerRequest)
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json(projection));
    const response = await GET(
      new Request("http://localhost:3070/api/ontos/account/consent", {
        headers: { cookie: "commerce-portal.session_token=customer" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ consent: projection });
    expect(vi.mocked(ownerRequest).mock.calls.map(([, path, init]) => [path, init.method])).toEqual(
      [
        ["/api/portal-auth/customer-consent", "GET"],
        ["/api/portal-auth/customer-consent", "GET"],
      ],
    );
  });

  it("never repeats a choice after an owner outage", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(Response.json({}, { status: 503 }));
    const origin = "http://localhost:3070";
    const response = await POST(
      new Request(`${origin}/api/ontos/account/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(input),
      }),
    );
    expect(response.status).toBe(503);
    expect(ownerRequest).toHaveBeenCalledOnce();
  });
});
