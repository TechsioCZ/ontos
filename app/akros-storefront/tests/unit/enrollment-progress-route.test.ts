import { beforeEach, expect, it, vi } from "vitest";
import { GET, POST, PUT } from "@/app/api/ontos/enrollment/route";
import { OntosError, ownerRequest } from "@/ontos/gateway";

vi.mock("@/ontos/gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ontos/gateway")>()),
  ownerRequest: vi.fn<typeof ownerRequest>(),
}));
const origin = "http://localhost:3070";
const url = `${origin}/api/ontos/enrollment`;
const cookie = "staff.session=private; commerce-portal.session_token=customer";
beforeEach(() => vi.resetAllMocks());

it("reloads progress from the verified owner without any browser registration handle", async () => {
  vi.mocked(ownerRequest)
    .mockResolvedValueOnce(Response.json({ code: "account_disabled" }, { status: 403 }))
    .mockResolvedValueOnce(
      Response.json({
        state: "RECONCILIATION_REQUIRED",
        revision: 7,
        portalEnrollmentAttemptId: "private",
        providerSubjectId: "private",
      }),
    );
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(await response.json()).toEqual({ state: "RECONCILIATION_REQUIRED", revision: 7 });
  const [, path, init] = vi.mocked(ownerRequest).mock.calls[1]!;
  expect(path).toBe("/api/portal-auth/enrollment/current");
  expect(init.method).toBe("GET");
  expect(new Headers(init.headers).get("cookie")).toBe("commerce-portal.session_token=customer");
  expect(init.body).toBeUndefined();
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("confirms real customer admission before navigation, including mid-session binding", async () => {
  vi.mocked(ownerRequest).mockResolvedValue(Response.json({ state: "authenticated" }));
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(await response.json()).toEqual({ state: "ADMITTED" });
  expect(ownerRequest).toHaveBeenCalledOnce();
});

it("admits a verified customer after a transient account-status outage", async () => {
  vi.mocked(ownerRequest)
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ state: "authenticated" }));
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "ADMITTED" });
  expect(vi.mocked(ownerRequest).mock.calls.map(([, path]) => path)).toEqual([
    "/api/portal-auth/customer-account",
    "/api/portal-auth/customer-account",
  ]);
  for (const [, , init] of vi.mocked(ownerRequest).mock.calls) {
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("cookie")).toBe("commerce-portal.session_token=customer");
  }
});

it("recovers a transient gateway transport failure before the account response", async () => {
  vi.mocked(ownerRequest)
    .mockRejectedValueOnce(new OntosError("Owner unavailable", 503, "backend_unreachable"))
    .mockResolvedValueOnce(Response.json({ state: "authenticated" }));
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "ADMITTED" });
  expect(ownerRequest).toHaveBeenCalledTimes(2);
});

it("bounds unavailable transport retries and never treats them as admission", async () => {
  vi.mocked(ownerRequest).mockRejectedValue(
    new OntosError("Owner unavailable", 503, "backend_unreachable"),
  );
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty("state");
  expect(ownerRequest).toHaveBeenCalledTimes(3);
});

it.each([
  [503, "storefront_not_configured"],
  [403, "gateway_forbidden"],
])("does not retry a configuration error or gateway denial (%s, %s)", async (status, code) => {
  vi.mocked(ownerRequest).mockRejectedValue(new OntosError("Account read refused", status, code));
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty("state");
  expect(ownerRequest).toHaveBeenCalledOnce();
});

it("reads pending enrollment after a transient outage without inventing customer admission", async () => {
  vi.mocked(ownerRequest)
    .mockResolvedValueOnce(Response.json({}, { status: 403 }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ state: "VERIFICATION_REQUIRED", revision: 3 }));
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "VERIFICATION_REQUIRED", revision: 3 });
  expect(vi.mocked(ownerRequest).mock.calls.map(([, path]) => path)).toEqual([
    "/api/portal-auth/customer-account",
    "/api/portal-auth/enrollment/current",
    "/api/portal-auth/enrollment/current",
  ]);
});

it("stops after three unavailable account reads and keeps access closed", async () => {
  vi.mocked(ownerRequest).mockImplementation(async () => Response.json({}, { status: 503 }));
  const response = await GET(new Request(url, { headers: { cookie } }));
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty("state");
  expect(ownerRequest).toHaveBeenCalledTimes(3);
  expect(
    vi
      .mocked(ownerRequest)
      .mock.calls.every(([, path]) => path === "/api/portal-auth/customer-account"),
  ).toBe(true);
});

it("sends only the native current-subject resume with no Attempt, Party or email authority", async () => {
  vi.mocked(ownerRequest)
    .mockResolvedValueOnce(Response.json({}, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ state: "IN_PROGRESS", revision: 8 }));
  const response = await POST(
    new Request(url, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(200);
  const [, path, init] = vi.mocked(ownerRequest).mock.calls[1]!;
  expect(path).toBe("/api/portal-auth/enrollment/current/resume");
  expect(init.method).toBe("POST");
  expect(init.body).toBe("{}");
  expect(new Headers(init.headers).has("idempotency-key")).toBe(false);
});

it("refuses browser identifiers and cross-origin resumes before any owner request", async () => {
  for (const [target, body, requestOrigin] of [
    [`${url}?attemptId=foreign`, "{}", origin],
    [url, '{"partyId":"foreign"}', origin],
    [url, '{"email":"other@example.test"}', origin],
    [url, "{}", "https://other.example"],
  ]) {
    const response = await POST(
      new Request(target!, {
        method: "POST",
        headers: { "content-type": "application/json", origin: requestOrigin! },
        body,
      }),
    );
    expect([400, 403]).toContain(response.status);
  }
  expect(ownerRequest).not.toHaveBeenCalled();
});

it.each([401, 404, 429, 503])(
  "preserves an actual owner refusal (%s), never inventing enrollment progress",
  async (status) => {
    vi.mocked(ownerRequest).mockImplementation(async (_owner, path) =>
      Response.json({}, { status: path === "/api/portal-auth/customer-account" ? 403 : status }),
    );
    const response = await GET(new Request(url));
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("state");
    expect(ownerRequest).toHaveBeenCalledTimes(status === 503 ? 4 : 2);
  },
);

it.each([POST, PUT])("never replays an unavailable enrollment write", async (handler) => {
  vi.mocked(ownerRequest)
    .mockResolvedValueOnce(Response.json({}, { status: 403 }))
    .mockResolvedValueOnce(Response.json({}, { status: 503 }));
  const response = await handler(
    new Request(url, {
      method: handler === POST ? "POST" : "PUT",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(503);
  expect(ownerRequest).toHaveBeenCalledTimes(2);
  expect(vi.mocked(ownerRequest).mock.calls[1]![2].method).toBe("POST");
});

it("starts a native existing-account enrollment with only an empty verified-session request", async () => {
  vi.mocked(ownerRequest)
    .mockResolvedValueOnce(Response.json({}, { status: 403 }))
    .mockResolvedValueOnce(
      Response.json({ state: "IN_PROGRESS", revision: 2, portalEnrollmentAttemptId: "private" }),
    );
  const response = await PUT(
    new Request(url, {
      method: "PUT",
      headers: { cookie, origin, "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(await response.json()).toEqual({ state: "IN_PROGRESS", revision: 2 });
  const [, path, init] = vi.mocked(ownerRequest).mock.calls[1]!;
  expect(path).toBe("/api/portal-auth/enrollment/current/restart");
  expect(init.method).toBe("POST");
  expect(init.body).toBe("{}");
  expect(new Headers(init.headers).has("idempotency-key")).toBe(false);
});

it("refuses foreign or caller-selected restart authority before contacting the owner", async () => {
  for (const body of [
    '{"attemptId":"old"}',
    '{"partyId":"foreign"}',
    '{"email":"foreign@example.test"}',
  ]) {
    const response = await PUT(
      new Request(url, {
        method: "PUT",
        headers: { cookie, origin, "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBe(400);
  }
  expect(ownerRequest).not.toHaveBeenCalled();
});
