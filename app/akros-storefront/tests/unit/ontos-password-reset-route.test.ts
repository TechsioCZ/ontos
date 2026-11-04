import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/account/route";
import { GET as resetCallback } from "@/app/commerce-customer-context-api/api/portal-auth/reset-password/[token]/route";
import { passwordResetToken } from "@/ontos/account";
import { ownerRequest } from "@/ontos/gateway";

vi.mock("@/ontos/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ontos/gateway")>()),
  ownerRequest: vi.fn<typeof ownerRequest>(),
}));
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({ legalEntityId: "server-selling-entity" }),
}));

const origin = "http://localhost:3070";
const password = "long-enough-password";
const cookieName = "akros-password-reset";

function submit(body: object, cookie?: string) {
  return POST(
    new Request(`${origin}/api/ontos/account`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    }),
  );
}
const ownerCall = (index = 0) => vi.mocked(ownerRequest).mock.calls[index];
const ownerBody = (index = 0) => JSON.parse(String(ownerCall(index)?.[2]?.body));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("password recovery transport", () => {
  it("starts recovery for a normalized e-mail without relaying any browser cookie", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json({ outcome: "ACCOUNT_RECOVERY_STARTED" }),
    );
    const response = await submit(
      { operation: "request-password-reset", email: " Real@Example.TEST " },
      "commerce-portal.session_token=customer",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "ACCOUNT_RECOVERY_STARTED" });
    expect(ownerCall()?.[1]).toBe("/api/portal-auth/request-password-reset");
    expect(ownerBody()).toEqual({ email: "real@example.test" });
    expect(ownerCall()?.[2]?.headers).not.toHaveProperty(
      "cookie",
      expect.stringContaining("customer"),
    );
  });

  it.each([
    { operation: "request-password-reset", email: "not-an-address" },
    { operation: "request-password-reset", email: "real@example.test", extra: "field" },
  ])("rejects a malformed recovery request before the owner: %o", async (input) => {
    expect((await submit(input)).status).toBe(400);
    expect(ownerRequest).not.toHaveBeenCalled();
  });

  it("reports a rate-limited recovery request without starting another one", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(Response.json({}, { status: 429 }));
    const response = await submit({
      operation: "request-password-reset",
      email: "real@example.test",
    });
    expect(response.status).toBe(429);
    expect(ownerRequest).toHaveBeenCalledOnce();
  });

  it("sends the new password with the token from the HttpOnly cookie and clears that cookie", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(
      Response.json({ outcome: "ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT" }),
    );
    const response = await submit(
      {
        operation: "reset-password",
        newPassword: password,
        passwordConfirmation: password,
      },
      `${cookieName}=reset-token-value; other=1`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "PASSWORD_RESET_COMPLETED" });
    expect(response.headers.get("set-cookie")).toContain(`${cookieName}=;`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(ownerCall()?.[1]).toBe("/api/portal-auth/reset-password");
    expect(ownerBody()).toEqual({ newPassword: password, token: "reset-token-value" });
  });

  it("refuses a reset without the cookie before contacting the owner", async () => {
    const response = await submit({
      operation: "reset-password",
      newPassword: password,
      passwordConfirmation: password,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "Odkaz pro nastavení hesla vypršel nebo už byl použit. Požádejte prosím o nový.",
    });
    expect(ownerRequest).not.toHaveBeenCalled();
  });

  it("refuses mismatched or short passwords before the owner", async () => {
    const cookie = `${cookieName}=reset-token-value`;
    for (const body of [
      {
        operation: "reset-password",
        newPassword: password,
        passwordConfirmation: "different-password",
      },
      { operation: "reset-password", newPassword: "short", passwordConfirmation: "short" },
    ]) {
      expect((await submit(body, cookie)).status).toBe(400);
    }
    expect(ownerRequest).not.toHaveBeenCalled();
  });

  it("never replays a reset whose token the owner rejects and clears the cookie", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(Response.json({}, { status: 400 }));
    const response = await submit(
      { operation: "reset-password", newPassword: password, passwordConfirmation: password },
      `${cookieName}=used-token`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(ownerRequest).toHaveBeenCalledOnce();
  });

  it("answers an unavailable owner for a reset with a retryable status and no replay", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(Response.json({}, { status: 503 }));
    const response = await submit(
      { operation: "reset-password", newPassword: password, passwordConfirmation: password },
      `${cookieName}=reset-token-value`,
    );
    expect(response.status).toBe(503);
    expect(ownerRequest).toHaveBeenCalledOnce();
  });
});

describe("password reset mail callback", () => {
  const callback = (token: string) =>
    resetCallback(
      new Request(
        `${origin}/commerce-customer-context-api/api/portal-auth/reset-password/${token}`,
      ),
      { params: Promise.resolve({ token }) },
    );

  it("moves an accepted token into the HttpOnly cookie and lands on the fixed reset page", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(Response.json({ outcome: "PASSWORD_RESET_PENDING" }));
    const response = await callback("reset-token-value");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/cs/obnova-hesla`);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${cookieName}=reset-token-value`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(ownerCall()?.[1]).toBe("/api/portal-auth/reset-password/reset-token-value");
    expect(response.headers.get("location")).not.toContain("reset-token-value");
  });

  it("does not store a token the owner did not accept", async () => {
    vi.mocked(ownerRequest).mockResolvedValue(Response.json({}, { status: 400 }));
    const response = await callback("expired-token");
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("does not call the owner for a token that cannot be a cookie value", async () => {
    const response = await callback("bad;token");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(ownerRequest).not.toHaveBeenCalled();
  });
});

describe("password reset cookie", () => {
  it("accepts one copy of the credential and refuses competing copies", () => {
    expect(passwordResetToken(`a=1; ${cookieName}=one-token`)).toBe("one-token");
    expect(passwordResetToken(`${cookieName}=one; ${cookieName}=two`)).toBeNull();
    expect(passwordResetToken(null)).toBeNull();
  });
});
