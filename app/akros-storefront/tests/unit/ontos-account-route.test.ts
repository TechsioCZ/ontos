import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/ontos/account/route";
import { portalCookie, registrationInput } from "@/ontos/account";
import { ownerRequest } from "@/ontos/gateway";

vi.mock("@/ontos/gateway", () => ({ ownerRequest: vi.fn<typeof ownerRequest>() }));
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({ legalEntityId: "server-selling-entity" }),
}));
const origin = "http://localhost:3070";
const requestId = "a1234567-1234-4234-8234-123456789abc";
const registration = {
  operation: "register",
  firstName: "Real",
  lastName: "Customer",
  email: "REAL@EXAMPLE.TEST",
  password: "long-enough-password",
  passwordConfirmation: "long-enough-password",
  phone: "+420 777 123 456",
  termsAccepted: true,
  requestId,
};
function submit(body: object, requestOrigin: string | null = origin) {
  return POST(
    new Request(`${origin}/api/ontos/account`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(requestOrigin === null ? {} : { origin: requestOrigin }),
        cookie: "staff.session=private; commerce-portal.session_token=customer",
      },
      body: JSON.stringify(body),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
});

describe("owner-backed customer account transport", () => {
  it("forwards only the isolated portal realm cookie", () => {
    expect(
      portalCookie(
        "staff.session=secret; commerce-portal.session_token=one; __Secure-commerce-portal.session_data=two; arbitrary=three",
      ),
    ).toBe("commerce-portal.session_token=one; __Secure-commerce-portal.session_data=two");
  });
  it("stages real names and phone but takes selling scope only from server configuration", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json({
        outcome: "CREATED",
        attempt: { state: "IN_PROGRESS" },
        providerSubjectId: "not-public",
      }),
    );
    const response = await submit({
      ...registration,
      sellingLegalEntityId: "attacker",
      partyId: "attacker",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "ENROLLMENT_STARTED" });
    const [audience, path, init] = vi.mocked(ownerRequest).mock.calls[0]!;
    expect(audience).toBe("commerce-customer-context");
    expect(path).toBe("/api/portal-auth/enrollment/start");
    expect(JSON.parse(String(init.body))).toEqual({
      displayName: "Real Customer",
      email: "real@example.test",
      password: registration.password,
      phone: registration.phone,
      journey: "RETAIL_SELF_ENROLLMENT",
      sellingLegalEntityId: "server-selling-entity",
    });
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("commerce-portal.session_token=customer");
    expect(headers.get("idempotency-key")).toBe(`storefront-enrollment:${requestId}`);
    expect(headers.get("idempotency-key")).not.toContain(registration.password);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    { password: "short", passwordConfirmation: "short" },
    { passwordConfirmation: "different-password" },
    { termsAccepted: false },
    { requestId: "-".repeat(36) },
  ])("rejects invalid registration before any owner call (%j)", async (invalid) => {
    expect((await submit({ ...registration, ...invalid })).status).toBe(400);
    expect(ownerRequest).not.toHaveBeenCalled();
  });
  it("enforces minimum 12 before sending the credential to its owner", () => {
    expect(() =>
      registrationInput({
        ...registration,
        password: "a".repeat(11),
        passwordConfirmation: "a".repeat(11),
      }),
    ).toThrow(/12 až 128/);
    expect(
      registrationInput({
        ...registration,
        password: "a".repeat(12),
        passwordConfirmation: "a".repeat(12),
      }).password,
    ).toHaveLength(12);
  });
  it.each([null, "https://foreign.example.test"])(
    "refuses a missing or foreign origin before authentication (%s)",
    async (value) => {
      expect((await submit({ operation: "logout" }, value)).status).toBe(403);
      expect(ownerRequest).not.toHaveBeenCalled();
    },
  );
  it.each(["unknown@example.test", "known@example.test"])(
    "does not admit rejected credentials for %s",
    async (email) => {
      vi.mocked(ownerRequest).mockResolvedValue(
        Response.json(
          { code: "invalid_credentials", token: "never-forward" },
          { status: 401, headers: { "set-cookie": "commerce-portal.session_token=bad; HttpOnly" } },
        ),
      );
      const response = await submit({ operation: "login", email, password: "wrong-password" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Nesprávný e-mail nebo heslo." });
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
  it("forwards a real admitted session cookie, never staff cookies or provider metadata", async () => {
    const upstream = new Headers();
    upstream.append("set-cookie", "commerce-portal.session_token=real; HttpOnly; SameSite=Lax");
    upstream.append("set-cookie", "staff.session=not-the-customer-realm; HttpOnly");
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json(
        {
          outcome: "SESSION_CREATED",
          session: { providerSubjectId: "internal", sessionRef: "internal" },
        },
        { headers: upstream },
      ),
    );
    const response = await submit({
      operation: "login",
      email: registration.email,
      password: registration.password,
    });
    expect(await response.json()).toEqual({ outcome: "SESSION_CREATED" });
    expect(response.headers.getSetCookie()).toEqual([
      "commerce-portal.session_token=real; HttpOnly; SameSite=Lax",
    ]);
  });
  it("does not forward pending MFA cookies as a completed login", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json(
        { outcome: "MFA_REQUIRED" },
        { headers: { "set-cookie": "commerce-portal.session_token=pending; HttpOnly" } },
      ),
    );
    const response = await submit({
      operation: "login",
      email: registration.email,
      password: registration.password,
    });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it("reads only the live owner-admitted account and strips extra fields", async () => {
    const account = {
      id: "provider-subject",
      partyId: "party",
      tenantId: "tenant",
      name: "Real Customer",
      email: "real@example.test",
    };
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json({
        state: "authenticated",
        account: { ...account, token: "private" },
        session: "private",
      }),
    );
    const response = await GET(
      new Request(`${origin}/api/ontos/account`, {
        headers: { cookie: "commerce-portal.session_token=real" },
      }),
    );
    expect(await response.json()).toEqual({ account });
    expect(vi.mocked(ownerRequest).mock.calls[0]![1]).toBe("/api/portal-auth/customer-account");
  });
  it("returns anonymous for a revoked session and never invents a customer", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json({ code: "authentication_failed" }, { status: 401 }),
    );
    const response = await GET(new Request(`${origin}/api/ontos/account`));
    expect(await response.json()).toEqual({ account: null });
  });
  it("logs out through the real owner and forwards only its expired realm cookie", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json(
        { outcome: "SESSION_REVOKED" },
        { headers: { "set-cookie": "commerce-portal.session_token=; Max-Age=0; HttpOnly" } },
      ),
    );
    const response = await submit({ operation: "logout", partyId: "ignored" });
    expect(response.status).toBe(200);
    expect(vi.mocked(ownerRequest).mock.calls[0]![1]).toBe("/api/portal-auth/sign-out");
    expect(response.headers.getSetCookie()).toEqual([
      "commerce-portal.session_token=; Max-Age=0; HttpOnly",
    ]);
  });
});

describe("verification resend transport", () => {
  it.each(["unknown@example.test", "verified@example.test", "waiting@example.test"])(
    "returns the same acknowledgement for %s without forwarding identities or any realm cookies",
    async (email) => {
      vi.mocked(ownerRequest).mockResolvedValue(
        Response.json(
          { outcome: "EMAIL_VERIFICATION_STARTED", providerSubjectId: "private" },
          { headers: { "set-cookie": "commerce-portal.session_token=must-not-cross; HttpOnly" } },
        ),
      );
      const response = await submit({
        operation: "resend-verification",
        email: email.toUpperCase(),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "EMAIL_VERIFICATION_STARTED" });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const [owner, path, init] = vi.mocked(ownerRequest).mock.calls[0]!;
      expect(owner).toBe("commerce-customer-context");
      expect(path).toBe("/api/portal-auth/send-verification-email");
      expect(JSON.parse(String(init.body))).toEqual({ email });
      expect(new Headers(init.headers).get("cookie")).toBe("");
    },
  );
  it.each([
    { email: "invalid" },
    { email: "valid@example.test", providerSubjectId: "attacker" },
    { email: "valid@example.test", partyId: "attacker" },
    { email: "valid@example.test", password: "must-not-forward" },
  ])("rejects malformed or identity-bearing resend requests before the owner", async (input) => {
    expect((await submit({ operation: "resend-verification", ...input })).status).toBe(400);
    expect(ownerRequest).not.toHaveBeenCalled();
  });
  it.each([null, "https://attacker.example.test"])(
    "rejects an untrusted resend origin %s",
    async (value) => {
      expect(
        (await submit({ operation: "resend-verification", email: "valid@example.test" }, value))
          .status,
      ).toBe(403);
      expect(ownerRequest).not.toHaveBeenCalled();
    },
  );
  it("preserves owner throttling without exposing provider details or cookies", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json({ code: "rate_limited", providerSubjectId: "private" }, { status: 429 }),
    );
    const response = await submit({
      operation: "resend-verification",
      email: "valid@example.test",
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      message: "Příliš mnoho pokusů. Zkuste to prosím později.",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

it("lets the owner apply Party phone rules and preserves invalid-number rejection", async () => {
  vi.mocked(ownerRequest).mockResolvedValue(
    Response.json({ code: "invalid_request" }, { status: 400 }),
  );
  const response = await submit({ ...registration, phone: "---" });
  expect(response.status).toBe(400);
  expect(ownerRequest).toHaveBeenCalledOnce();
  expect(JSON.parse(String(vi.mocked(ownerRequest).mock.calls[0]![2].body)).phone).toBe("---");
});
