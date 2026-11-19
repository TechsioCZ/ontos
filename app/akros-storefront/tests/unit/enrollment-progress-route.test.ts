// @vitest-environment node
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, POST, PUT } from "@/app/api/ontos/enrollment/route";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const origin = "http://localhost:3070";
const url = `${origin}/api/ontos/enrollment`;
const cookie = "staff.session=private; commerce-portal.session_token=customer";
const contextPath = "/shell-super-app-api/auth/api-key/gateway-context";
const ownerBase = "/shell-super-app-api/commerce-customer-context";
const gatewayContext = {
  apiBaseUrl: ownerBase,
  compositionRevision: "a".repeat(64),
  token: "enrollment-test-assertion",
  expiresAt: 4_000_000_000,
};
let network: Awaited<ReturnType<typeof serveHttp>>;
let answers: Array<() => Response>;
let contextProblem: { status: number; code: string } | undefined;
let brokenShell: Awaited<ReturnType<typeof serveBrokenShell>> | undefined;

beforeEach(async () => {
  answers = [];
  contextProblem = undefined;
  network = await serveHttp((request) => {
    const path = new URL(request.url).pathname;
    if (path === contextPath) {
      return contextProblem
        ? Response.json({ code: contextProblem.code }, { status: contextProblem.status })
        : Response.json(gatewayContext);
    }
    const answer = answers.shift();
    if (!answer) throw new Error(`Unexpected owner request: ${request.method} ${path}`);
    return answer();
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "enrollment-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000024");
});

afterEach(async () => {
  try {
    await brokenShell?.close();
    await network.close();
  } finally {
    brokenShell = undefined;
    vi.unstubAllEnvs();
  }
  // Assert outside the server callback so its HTTP error handling cannot absorb a failed assertion.
  for (const request of network.requests) {
    const path = new URL(request.url).pathname;
    if (path === contextPath) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-api-key")).toBe("enrollment-test-key");
      expect(await request.json()).toEqual({
        audience: "commerce-customer-context",
        legalEntityId: "71000000-0000-4000-8000-000000000024",
      });
    } else {
      expect(path.startsWith(`${ownerBase}/api/portal-auth/`)).toBe(true);
      expect(request.headers.get("authorization")).toBe(`Bearer ${gatewayContext.token}`);
      expect(request.headers.get("x-ontos-composition-revision")).toBe(
        gatewayContext.compositionRevision,
      );
    }
  }
});

const ownerRequests = () =>
  network.requests.filter((request) => new URL(request.url).pathname.startsWith(`${ownerBase}/`));
const ownerPaths = () =>
  ownerRequests().map((request) => new URL(request.url).pathname.slice(ownerBase.length));

async function call(handler: typeof GET, request: Request) {
  const context = nextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === null ? {} : { body: await request.text() }),
  });
  try {
    return await context.run(() => handler(context.request));
  } finally {
    await context.close();
    await network.idle();
    await setImmediate();
    await setImmediate();
  }
}

// Socket closure is a real transport failure, unlike a served HTTP 503.
async function serveBrokenShell(failures: number) {
  const paths: string[] = [];
  let remainingFailures = failures;
  const server = createServer(async (incoming, outgoing) => {
    for await (const _chunk of incoming) {
      // Receive the entire credential request before severing its connection.
    }
    const path = incoming.url ?? "";
    paths.push(path);
    if (path === contextPath && remainingFailures > 0) {
      remainingFailures -= 1;
      incoming.socket.destroy();
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify(path === contextPath ? gatewayContext : { state: "authenticated" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it("reloads progress from the verified owner without any browser registration handle", async () => {
  answers.push(
    () => Response.json({ code: "account_disabled" }, { status: 403 }),
    () =>
      Response.json({
        state: "RECONCILIATION_REQUIRED",
        revision: 7,
        portalEnrollmentAttemptId: "private",
        providerSubjectId: "private",
      }),
  );
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(await response.json()).toEqual({ state: "RECONCILIATION_REQUIRED", revision: 7 });
  const request = ownerRequests()[1]!;
  expect(new URL(request.url).pathname).toBe(`${ownerBase}/api/portal-auth/enrollment/current`);
  expect(request.method).toBe("GET");
  expect(request.headers.get("cookie")).toBe("commerce-portal.session_token=customer");
  expect(await request.text()).toBe("");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("confirms real customer admission before navigation, including mid-session binding", async () => {
  answers.push(() => Response.json({ state: "authenticated" }));
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(await response.json()).toEqual({ state: "ADMITTED" });
  expect(ownerRequests()).toHaveLength(1);
});

it("admits a verified customer after a transient account-status outage", async () => {
  answers.push(
    () => Response.json({}, { status: 503 }),
    () => Response.json({ state: "authenticated" }),
  );
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "ADMITTED" });
  expect(ownerPaths()).toEqual([
    "/api/portal-auth/customer-account",
    "/api/portal-auth/customer-account",
  ]);
  for (const request of ownerRequests()) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("cookie")).toBe("commerce-portal.session_token=customer");
  }
});

it("recovers a transient gateway transport failure before the account response", async () => {
  brokenShell = await serveBrokenShell(1);
  vi.stubEnv("ONTOS_SHELL_URL", brokenShell.origin);
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "ADMITTED" });
  expect(brokenShell.paths.filter((path) => path === contextPath)).toHaveLength(2);
  expect(brokenShell.paths).toEqual([
    contextPath,
    contextPath,
    `${ownerBase}/api/portal-auth/customer-account`,
  ]);
});

it("bounds unavailable transport retries and never treats them as admission", async () => {
  brokenShell = await serveBrokenShell(3);
  vi.stubEnv("ONTOS_SHELL_URL", brokenShell.origin);
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty("state");
  expect(brokenShell.paths).toEqual([contextPath, contextPath, contextPath]);
});

it.each([
  [503, "storefront_not_configured"],
  [403, "gateway_forbidden"],
])("does not retry a configuration error or gateway denial (%s, %s)", async (status, code) => {
  contextProblem = { status, code };
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty("state");
  // The failed mint is the one ownerRequest attempt; no owner HTTP call is authorized.
  expect(network.requests).toHaveLength(1);
  expect(new URL(network.requests[0]!.url).pathname).toBe(contextPath);
  expect(ownerRequests()).toHaveLength(0);
});

it("reads pending enrollment after a transient outage without inventing customer admission", async () => {
  answers.push(
    () => Response.json({}, { status: 403 }),
    () => Response.json({}, { status: 503 }),
    () => Response.json({ state: "VERIFICATION_REQUIRED", revision: 3 }),
  );
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "VERIFICATION_REQUIRED", revision: 3 });
  expect(ownerPaths()).toEqual([
    "/api/portal-auth/customer-account",
    "/api/portal-auth/enrollment/current",
    "/api/portal-auth/enrollment/current",
  ]);
});

it("stops after three unavailable account reads and keeps access closed", async () => {
  answers.push(...Array.from({ length: 3 }, () => () => Response.json({}, { status: 503 })));
  const response = await call(GET, new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty("state");
  expect(ownerRequests()).toHaveLength(3);
  expect(ownerPaths().every((path) => path === "/api/portal-auth/customer-account")).toBe(true);
});

it("sends only the native current-subject resume with no Attempt, Party or email authority", async () => {
  answers.push(
    () => Response.json({}, { status: 403 }),
    () => Response.json({ state: "IN_PROGRESS", revision: 8 }),
  );
  const response = await call(
    POST,
    new Request(url, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(200);
  const request = ownerRequests()[1]!;
  expect(new URL(request.url).pathname).toBe(
    `${ownerBase}/api/portal-auth/enrollment/current/resume`,
  );
  expect(request.method).toBe("POST");
  expect(await request.text()).toBe("{}");
  expect(request.headers.has("idempotency-key")).toBe(false);
});

it("refuses browser identifiers and cross-origin resumes before any owner request", async () => {
  for (const [target, body, requestOrigin] of [
    [`${url}?attemptId=foreign`, "{}", origin],
    [url, '{"partyId":"foreign"}', origin],
    [url, '{"email":"other@example.test"}', origin],
    [url, "{}", "https://other.example"],
  ]) {
    const response = await call(
      POST,
      new Request(target!, {
        method: "POST",
        headers: { "content-type": "application/json", origin: requestOrigin! },
        body,
      }),
    );
    expect([400, 403]).toContain(response.status);
  }
  expect(network.requests).toHaveLength(0);
});

it.each([401, 404, 429, 503])(
  "preserves an actual owner refusal (%s), never inventing enrollment progress",
  async (status) => {
    answers.push(
      () => Response.json({}, { status: 403 }),
      ...Array.from({ length: status === 503 ? 3 : 1 }, () => () => Response.json({}, { status })),
    );
    const response = await call(GET, new Request(url));
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("state");
    expect(ownerRequests()).toHaveLength(status === 503 ? 4 : 2);
  },
);

it.each([POST, PUT])("never replays an unavailable enrollment write", async (handler) => {
  answers.push(
    () => Response.json({}, { status: 403 }),
    () => Response.json({}, { status: 503 }),
  );
  const response = await call(
    handler,
    new Request(url, {
      method: handler === POST ? "POST" : "PUT",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(503);
  expect(ownerRequests()).toHaveLength(2);
  expect(ownerRequests()[1]!.method).toBe("POST");
});

it("starts a native existing-account enrollment with only an empty verified-session request", async () => {
  answers.push(
    () => Response.json({}, { status: 403 }),
    () =>
      Response.json({ state: "IN_PROGRESS", revision: 2, portalEnrollmentAttemptId: "private" }),
  );
  const response = await call(
    PUT,
    new Request(url, {
      method: "PUT",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(await response.json()).toEqual({ state: "IN_PROGRESS", revision: 2 });
  const request = ownerRequests()[1]!;
  expect(new URL(request.url).pathname).toBe(
    `${ownerBase}/api/portal-auth/enrollment/current/restart`,
  );
  expect(request.method).toBe("POST");
  expect(await request.text()).toBe("{}");
  expect(request.headers.has("idempotency-key")).toBe(false);
});

it("refuses foreign or caller-selected restart authority before contacting the owner", async () => {
  for (const body of [
    '{"attemptId":"old"}',
    '{"partyId":"foreign"}',
    '{"email":"foreign@example.test"}',
  ]) {
    const response = await call(
      PUT,
      new Request(url, {
        method: "PUT",
        headers: { cookie, origin, "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(400);
  }
  expect(network.requests).toHaveLength(0);
});
