// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/account/route";
import { GET as resetCallback } from "@/app/commerce-customer-context-api/api/portal-auth/reset-password/[token]/route";
import { passwordResetToken } from "@/ontos/account";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const gatewayPath = "/shell-super-app-api/auth/api-key/gateway-context";
const ownerBase = "/shell-super-app-api/commerce-customer-context";
const legalEntityId = "71000000-0000-4000-8000-000000000024";
const apiKey = "password-reset-test-api-key";
const gatewayToken = "password-reset-gateway-assertion";
const compositionRevision = "a".repeat(64);
let network: Awaited<ReturnType<typeof serveHttp>>;
let ownerReply: { body: object; status: number };

const origin = "http://localhost:3070";
const password = "long-enough-password";
const cookieName = "akros-password-reset";

async function submit(body: object, cookie?: string) {
  const context = nextRequest(`${origin}/api/ontos/account`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
  try {
    return await context.run(() => POST(context.request));
  } finally {
    await context.close();
  }
}

const ownerRequests = () =>
  network.requests.filter((request) =>
    new URL(request.url).pathname.startsWith(`${ownerBase}/api/portal-auth/`),
  );
const ownerPath = () => {
  const request = ownerRequests()[0];
  return request === undefined ? undefined : new URL(request.url).pathname.slice(ownerBase.length);
};
const ownerBody = async () => ownerRequests()[0]?.json();

beforeEach(async () => {
  ownerReply = { body: {}, status: 500 };
  network = await serveHttp((request) => {
    const path = new URL(request.url).pathname;
    if (path === gatewayPath) {
      return Response.json({
        apiBaseUrl: ownerBase,
        compositionRevision,
        token: gatewayToken,
        expiresAt: Date.now() + 60_000,
      });
    }
    if (path.startsWith(`${ownerBase}/api/portal-auth/`)) {
      return Response.json(ownerReply.body, { status: ownerReply.status });
    }
    return new Response("Unexpected route", { status: 404 });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", apiKey);
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
});

afterEach(async () => {
  try {
    await network.idle();
    for (const request of network.requests) {
      const path = new URL(request.url).pathname;
      if (path === gatewayPath) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("x-api-key")).toBe(apiKey);
        expect(await request.json()).toEqual({
          audience: "commerce-customer-context",
          legalEntityId,
        });
      } else {
        expect(path).toMatch(
          /^\/shell-super-app-api\/commerce-customer-context\/api\/portal-auth\//,
        );
        expect(request.headers.get("authorization")).toBe(`Bearer ${gatewayToken}`);
        expect(request.headers.get("x-ontos-composition-revision")).toBe(compositionRevision);
        expect(request.headers.get("origin")).toBe(origin);
      }
    }
  } finally {
    try {
      await network.close();
    } finally {
      vi.unstubAllEnvs();
    }
  }
});

describe("password recovery transport", () => {
  it("starts recovery for a normalized e-mail without relaying any browser cookie", async () => {
    ownerReply = { body: { outcome: "ACCOUNT_RECOVERY_STARTED" }, status: 200 };
    const response = await submit(
      { operation: "request-password-reset", email: " Real@Example.TEST " },
      "commerce-portal.session_token=customer",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "ACCOUNT_RECOVERY_STARTED" });
    expect(ownerPath()).toBe("/api/portal-auth/request-password-reset");
    expect(await ownerBody()).toEqual({ email: "real@example.test" });
    expect(ownerRequests()[0]?.headers.get("cookie")).toBe("");
  });

  it.each([
    { operation: "request-password-reset", email: "not-an-address" },
    { operation: "request-password-reset", email: "real@example.test", extra: "field" },
  ])("rejects a malformed recovery request before the owner: %o", async (input) => {
    expect((await submit(input)).status).toBe(400);
    await network.idle();
    expect(ownerRequests()).toHaveLength(0);
    expect(network.requests).toHaveLength(0);
  });

  it("reports a rate-limited recovery request without starting another one", async () => {
    ownerReply = { body: {}, status: 429 };
    const response = await submit({
      operation: "request-password-reset",
      email: "real@example.test",
    });
    expect(response.status).toBe(429);
    await network.idle();
    expect(ownerRequests()).toHaveLength(1);
    expect(
      network.requests.filter((request) => new URL(request.url).pathname === gatewayPath),
    ).toHaveLength(1);
  });

  it("sends the new password with the token from the HttpOnly cookie and clears that cookie", async () => {
    ownerReply = { body: { outcome: "ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT" }, status: 200 };
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
    expect(ownerPath()).toBe("/api/portal-auth/reset-password");
    expect(await ownerBody()).toEqual({ newPassword: password, token: "reset-token-value" });
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
    await network.idle();
    expect(ownerRequests()).toHaveLength(0);
    expect(network.requests).toHaveLength(0);
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
    await network.idle();
    expect(ownerRequests()).toHaveLength(0);
    expect(network.requests).toHaveLength(0);
  });

  it("never replays a reset whose token the owner rejects and clears the cookie", async () => {
    ownerReply = { body: {}, status: 400 };
    const response = await submit(
      { operation: "reset-password", newPassword: password, passwordConfirmation: password },
      `${cookieName}=used-token`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await network.idle();
    expect(ownerRequests()).toHaveLength(1);
    expect(
      network.requests.filter((request) => new URL(request.url).pathname === gatewayPath),
    ).toHaveLength(1);
  });

  it("answers an unavailable owner for a reset with a retryable status and no replay", async () => {
    ownerReply = { body: {}, status: 503 };
    const response = await submit(
      { operation: "reset-password", newPassword: password, passwordConfirmation: password },
      `${cookieName}=reset-token-value`,
    );
    expect(response.status).toBe(503);
    await network.idle();
    expect(ownerRequests()).toHaveLength(1);
    expect(
      network.requests.filter((request) => new URL(request.url).pathname === gatewayPath),
    ).toHaveLength(1);
  });
});

describe("password reset mail callback", () => {
  const callback = async (token: string) => {
    const context = nextRequest(
      `${origin}/commerce-customer-context-api/api/portal-auth/reset-password/${token}`,
    );
    try {
      return await context.run(() =>
        resetCallback(context.request, {
          params: Promise.resolve({ token }),
        }),
      );
    } finally {
      await context.close();
    }
  };

  it("moves an accepted token into the HttpOnly cookie and lands on the fixed reset page", async () => {
    ownerReply = { body: { outcome: "PASSWORD_RESET_PENDING" }, status: 200 };
    const response = await callback("reset-token-value");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/cs/obnova-hesla`);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${cookieName}=reset-token-value`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(ownerPath()).toBe("/api/portal-auth/reset-password/reset-token-value");
    expect(response.headers.get("location")).not.toContain("reset-token-value");
  });

  it("does not store a token the owner did not accept", async () => {
    ownerReply = { body: {}, status: 400 };
    const response = await callback("expired-token");
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("does not call the owner for a token that cannot be a cookie value", async () => {
    const response = await callback("bad;token");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    await network.idle();
    expect(ownerRequests()).toHaveLength(0);
    expect(network.requests).toHaveLength(0);
  });
});

describe("password reset cookie", () => {
  it("accepts one copy of the credential and refuses competing copies", () => {
    expect(passwordResetToken(`a=1; ${cookieName}=one-token`)).toBe("one-token");
    expect(passwordResetToken(`${cookieName}=one; ${cookieName}=two`)).toBeNull();
    expect(passwordResetToken(null)).toBeNull();
  });
});
