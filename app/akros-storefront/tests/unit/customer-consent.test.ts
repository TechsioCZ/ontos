import { describe, expect, it } from "vitest";
import { customerConsentInput, isCustomerNewsletterConsent } from "@/ontos/consent-model";
import { POST } from "@/app/api/ontos/account/consent/route";

const input = {
  decision: "GRANTED",
  noticeAcknowledged: true,
  noticeVersionId: "11111111-1111-4111-8111-111111111111",
  purposeVersionId: "22222222-2222-4222-8222-222222222222",
  requestId: "33333333-3333-4333-8333-333333333333",
};
const projection = {
  decision: "ABSENT",
  notice: {
    language: "cs",
    noticeVersionId: input.noticeVersionId,
    purposeVersionId: input.purposeVersionId,
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
    for (const malformed of [
      null,
      [],
      {},
      { ...input, decision: "ABSENT" },
      { ...input, decision: "REFUSED" },
      { ...input, noticeAcknowledged: false },
      { ...input, noticeAcknowledged: undefined },
      { ...input, noticeVersionId: "" },
      { ...input, purposeVersionId: "invented" },
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
      { ...projection, notice: { ...projection.notice, noticeVersionId: "invented" } },
      { ...projection, notice: { ...projection.notice, purposeVersionId: "invented" } },
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
  });
});
