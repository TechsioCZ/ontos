// @vitest-environment node
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/ontos/account/route";
import { GET as verifyEmail } from "@/app/commerce-customer-context-api/api/portal-auth/verify-email/route";
import { portalCookie, registrationInput } from "@/ontos/account";
import { nextRequest } from "../support/next-request";

const origin = "http://localhost:3070";
const sellingLegalEntityId = "71000000-0000-4000-8000-000000000024";
const ownerBase = "/shell-super-app-api/module-api/commerce-customer-context";
const disconnect = Symbol("disconnect after receiving credentials");
let ownerAnswer: (
  request: Request,
) => Response | typeof disconnect | Promise<Response | typeof disconnect>;
let ownerRequests: Request[];
let issuerRequests: Request[];
let network: { idle: () => Promise<void>; close: () => Promise<void> };

// This fixture needs separate Set-Cookie header lines and a real socket loss after a write arrives.
// Keep those wire behaviors here; no product transport, fetch, or framework module is replaced.
beforeEach(async () => {
  ownerRequests = [];
  issuerRequests = [];
  ownerAnswer = () => Response.json({ code: "unexpected_owner_request" }, { status: 500 });
  const issued = new Set<string>();
  let active = 0;
  let moves = 0;
  const server = createServer(async (incoming, outgoing) => {
    active += 1;
    moves += 1;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(`${shellOrigin}${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}),
      });
      let response: Response | typeof disconnect;
      if (new URL(request.url).pathname === "/shell-super-app-api/auth/api-key/gateway-context") {
        issuerRequests.push(request.clone());
        const input: unknown = await request.json();
        if (
          request.method !== "POST" ||
          request.headers.get("x-api-key") !== "account-route-test-key" ||
          typeof input !== "object" ||
          input === null ||
          !("audience" in input) ||
          input.audience !== "commerce-customer-context" ||
          !("legalEntityId" in input) ||
          input.legalEntityId !== sellingLegalEntityId
        ) {
          response = Response.json({ code: "invalid_gateway_request" }, { status: 403 });
        } else {
          const token = `account-request-${issuerRequests.length}`;
          issued.add(`Bearer ${token}`);
          response = Response.json({
            apiBaseUrl: ownerBase,
            compositionRevision: "a".repeat(64),
            token,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          });
        }
      } else if (new URL(request.url).pathname.startsWith(`${ownerBase}/api/`)) {
        ownerRequests.push(request.clone());
        const authorization = request.headers.get("authorization") ?? "";
        if (
          !issued.delete(authorization) ||
          request.headers.get("x-ontos-composition-revision") !== "a".repeat(64)
        ) {
          response = Response.json({ code: "invalid_gateway_context" }, { status: 401 });
        } else response = await ownerAnswer(request);
      } else response = Response.json({ code: "unexpected_path" }, { status: 404 });
      if (response === disconnect) {
        incoming.socket.destroy();
        return;
      }
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.end(String(error));
    } finally {
      active -= 1;
      moves += 1;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  const shellOrigin = `http://127.0.0.1:${address.port}`;
  network = {
    async idle() {
      for (;;) {
        const before = moves;
        await setImmediate();
        await setImmediate();
        if (active === 0 && moves === before) return;
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  vi.stubEnv("ONTOS_SHELL_URL", shellOrigin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "account-route-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", sellingLegalEntityId);
  vi.stubEnv("ONTOS_STOREFRONT_APP_ID", "akros-storefront");
});
afterEach(async () => {
  try {
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function callRoute(route: (request: Request) => Promise<Response>, request: Request) {
  const context = nextRequest(request.url, { method: request.method, headers: request.headers });
  try {
    return await context.run(() => route(request));
  } finally {
    await context.close();
    await network.idle();
  }
}
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
  return callRoute(
    POST,
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

describe("owner-backed customer account transport", () => {
  it("rejects a native no-JS form POST with a clean 303 without reading or forwarding credentials", async () => {
    const request = new Request(`${origin}/api/ontos/account`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([["password", "native-form-probe"]]),
    });
    const response = await callRoute(POST, request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/prihlaseni");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
    expect(request.bodyUsed).toBe(false);
    expect(ownerRequests).toHaveLength(0);
    expect(issuerRequests).toHaveLength(0);
  });
  it("loads the admitted account after a transient owner outage", async () => {
    const account = {
      id: "provider-subject",
      partyId: "party",
      tenantId: "tenant",
      name: "Real Customer",
      email: "real@example.test",
    };
    let reads = 0;
    ownerAnswer = () =>
      ++reads === 1
        ? Response.json({}, { status: 503 })
        : Response.json({ state: "authenticated", account });
    const response = await callRoute(
      GET,
      new Request(`${origin}/api/ontos/account`, {
        headers: { cookie: "commerce-portal.session_token=real" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account });
    expect(ownerRequests).toHaveLength(2);
    expect(issuerRequests).toHaveLength(2);
  });
  it.each([
    registration,
    { operation: "login", email: registration.email, password: registration.password },
    { operation: "resend-verification", email: registration.email },
    { operation: "logout" },
  ])("never replays an unavailable credential or account write", async (input) => {
    ownerAnswer = () => Response.json({}, { status: 503 });
    const response = await submit(input);
    expect(response.status).toBe(503);
    expect(ownerRequests).toHaveLength(1);
    expect(issuerRequests).toHaveLength(1);
  });
  it("never replays credentials after an ambiguous transport failure", async () => {
    ownerAnswer = () => disconnect;
    const response = await submit({
      operation: "login",
      email: registration.email,
      password: registration.password,
    });
    expect(response.status).toBe(503);
    expect(ownerRequests).toHaveLength(1);
    expect(issuerRequests).toHaveLength(1);
  });
  it("never replays a GET that consumes an email-verification token", async () => {
    ownerAnswer = () => Response.json({}, { status: 503 });
    const response = await callRoute(
      verifyEmail,
      new Request(
        `${origin}/commerce-customer-context-api/api/portal-auth/verify-email?token=one-time-test-token`,
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/overeni-emailu?stav=nedostupne`);
    expect(ownerRequests).toHaveLength(1);
    expect(issuerRequests).toHaveLength(1);
  });
  it("forwards only the isolated portal realm cookie", () => {
    expect(
      portalCookie(
        "staff.session=secret; commerce-portal.session_token=one; __Secure-commerce-portal.session_data=two; arbitrary=three",
      ),
    ).toBe("commerce-portal.session_token=one; __Secure-commerce-portal.session_data=two");
  });
  it("stages real names and phone but takes selling scope only from server configuration", async () => {
    ownerAnswer = () =>
      Response.json({
        outcome: "CREATED",
        attempt: { state: "IN_PROGRESS" },
        providerSubjectId: "not-public",
      });
    const response = await submit({
      ...registration,
      sellingLegalEntityId: "attacker",
      partyId: "attacker",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "ENROLLMENT_STARTED" });
    const sent = ownerRequests[0]!;
    expect((await issuerRequests[0]!.json()).audience).toBe("commerce-customer-context");
    expect(new URL(sent.url).pathname).toBe(`${ownerBase}/api/portal-auth/enrollment/start`);
    expect(await sent.json()).toEqual({
      displayName: "Real Customer",
      email: "real@example.test",
      password: registration.password,
      phone: registration.phone,
      journey: "RETAIL_SELF_ENROLLMENT",
      sellingLegalEntityId,
    });
    const headers = sent.headers;
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
    expect(ownerRequests).toHaveLength(0);
    expect(issuerRequests).toHaveLength(0);
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
      expect(ownerRequests).toHaveLength(0);
      expect(issuerRequests).toHaveLength(0);
    },
  );
  it.each(["unknown@example.test", "known@example.test"])(
    "does not admit rejected credentials for %s",
    async (email) => {
      ownerAnswer = () =>
        Response.json(
          { code: "invalid_credentials", token: "never-forward" },
          { status: 401, headers: { "set-cookie": "commerce-portal.session_token=bad; HttpOnly" } },
        );
      const response = await submit({ operation: "login", email, password: "wrong-password" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Nesprávný e-mail nebo heslo." });
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
  it("exposes only the typed verification-required code for a rejected login", async () => {
    ownerAnswer = () =>
      Response.json(
        { code: "verification_required", providerSubjectId: "private", token: "private" },
        { status: 403 },
      );
    const response = await submit({
      operation: "login",
      email: registration.email,
      password: registration.password,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "verification_required",
      message: "Nejprve potvrďte e-mail odkazem, který jsme vám poslali.",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it("does not forward arbitrary provider error codes", async () => {
    ownerAnswer = () => Response.json({ code: "provider_internal_error" }, { status: 503 });
    const response = await submit({
      operation: "login",
      email: registration.email,
      password: registration.password,
    });
    expect(await response.json()).not.toHaveProperty("code");
  });
  it("forwards a real admitted session cookie, never staff cookies or provider metadata", async () => {
    const upstream = new Headers();
    upstream.append("set-cookie", "commerce-portal.session_token=real; HttpOnly; SameSite=Lax");
    upstream.append("set-cookie", "staff.session=not-the-customer-realm; HttpOnly");
    ownerAnswer = () =>
      Response.json(
        {
          outcome: "SESSION_CREATED",
          session: { providerSubjectId: "internal", sessionRef: "internal" },
        },
        { headers: upstream },
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
    ownerAnswer = () =>
      Response.json(
        { outcome: "MFA_REQUIRED" },
        { headers: { "set-cookie": "commerce-portal.session_token=pending; HttpOnly" } },
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
    ownerAnswer = () =>
      Response.json({
        state: "authenticated",
        account: { ...account, token: "private" },
        session: "private",
      });
    const response = await callRoute(
      GET,
      new Request(`${origin}/api/ontos/account`, {
        headers: { cookie: "commerce-portal.session_token=real" },
      }),
    );
    expect(await response.json()).toEqual({ account });
    expect(new URL(ownerRequests[0]!.url).pathname).toBe(
      `${ownerBase}/api/portal-auth/customer-account`,
    );
  });
  it("returns anonymous for a revoked session and never invents a customer", async () => {
    ownerAnswer = () => Response.json({ code: "authentication_failed" }, { status: 401 });
    const response = await callRoute(GET, new Request(`${origin}/api/ontos/account`));
    expect(await response.json()).toEqual({ account: null });
  });
  it("logs out through the real owner and forwards only its expired realm cookie", async () => {
    ownerAnswer = () =>
      Response.json(
        { outcome: "SESSION_REVOKED" },
        { headers: { "set-cookie": "commerce-portal.session_token=; Max-Age=0; HttpOnly" } },
      );
    const response = await submit({ operation: "logout", partyId: "ignored" });
    expect(response.status).toBe(200);
    expect(new URL(ownerRequests[0]!.url).pathname).toBe(`${ownerBase}/api/portal-auth/sign-out`);
    expect(response.headers.getSetCookie()).toEqual([
      "commerce-portal.session_token=; Max-Age=0; HttpOnly",
    ]);
  });
});

describe("verification resend transport", () => {
  it.each(["unknown@example.test", "verified@example.test", "waiting@example.test"])(
    "returns the same acknowledgement for %s without forwarding identities or any realm cookies",
    async (email) => {
      ownerAnswer = () =>
        Response.json(
          { outcome: "EMAIL_VERIFICATION_STARTED", providerSubjectId: "private" },
          { headers: { "set-cookie": "commerce-portal.session_token=must-not-cross; HttpOnly" } },
        );
      const response = await submit({
        operation: "resend-verification",
        email: email.toUpperCase(),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "EMAIL_VERIFICATION_STARTED" });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const sent = ownerRequests[0]!;
      expect((await issuerRequests[0]!.json()).audience).toBe("commerce-customer-context");
      expect(new URL(sent.url).pathname).toBe(
        `${ownerBase}/api/portal-auth/send-verification-email`,
      );
      expect(await sent.json()).toEqual({ email });
      expect(sent.headers.get("cookie")).toBe("");
    },
  );
  it.each([
    { email: "invalid" },
    { email: "valid@example.test", providerSubjectId: "attacker" },
    { email: "valid@example.test", partyId: "attacker" },
    { email: "valid@example.test", password: "must-not-forward" },
  ])("rejects malformed or identity-bearing resend requests before the owner", async (input) => {
    expect((await submit({ operation: "resend-verification", ...input })).status).toBe(400);
    expect(ownerRequests).toHaveLength(0);
    expect(issuerRequests).toHaveLength(0);
  });
  it.each([null, "https://attacker.example.test"])(
    "rejects an untrusted resend origin %s",
    async (value) => {
      expect(
        (await submit({ operation: "resend-verification", email: "valid@example.test" }, value))
          .status,
      ).toBe(403);
      expect(ownerRequests).toHaveLength(0);
      expect(issuerRequests).toHaveLength(0);
    },
  );
  it("preserves owner throttling without exposing provider details or cookies", async () => {
    ownerAnswer = () =>
      Response.json({ code: "rate_limited", providerSubjectId: "private" }, { status: 429 });
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
  ownerAnswer = () => Response.json({ code: "invalid_request" }, { status: 400 });
  const response = await submit({ ...registration, phone: "---" });
  expect(response.status).toBe(400);
  expect(ownerRequests).toHaveLength(1);
  expect(issuerRequests).toHaveLength(1);
  expect((await ownerRequests[0]!.json()).phone).toBe("---");
});

describe("account messages follow the market language", () => {
  const submitIn = (locale: string | undefined, body: object) =>
    callRoute(
      POST,
      new Request(`${origin}/api/ontos/account`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          ...(locale === undefined ? {} : { "x-akros-market-locale": locale }),
        },
        body: JSON.stringify(body),
      }),
    );
  it.each([
    [undefined, "Nesprávný e-mail nebo heslo."],
    ["sk", "Nesprávny e-mail alebo heslo."],
    ["en", "Incorrect e-mail or password."],
  ])("words rejected credentials for locale %s", async (locale, message) => {
    ownerAnswer = () => Response.json({ code: "invalid_credentials" }, { status: 401 });
    const response = await submitIn(locale, {
      operation: "login",
      email: "a@example.test",
      password: "wrong-password",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message });
  });
  it.each([
    [undefined, "Zkontrolujte údaje, souhlas a shodu hesel (12 až 128 znaků)."],
    ["sk", "Skontrolujte údaje, súhlas a zhodu hesiel (12 až 128 znakov)."],
    ["en", "Check your details, consent and that the passwords match (12 to 128 characters)."],
  ])("refuses an invalid registration for locale %s", async (locale, message) => {
    const response = await submitIn(locale, { ...registration, passwordConfirmation: "other" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
    expect(ownerRequests).toHaveLength(0);
    expect(issuerRequests).toHaveLength(0);
  });
  it.each([
    [undefined, "Neznámý požadavek."],
    ["sk", "Neznáma požiadavka."],
    ["en", "Unknown request."],
  ])("refuses an unknown operation for locale %s", async (locale, message) => {
    const response = await submitIn(locale, { operation: "nope" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
  });
});
