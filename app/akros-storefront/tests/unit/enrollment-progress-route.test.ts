import { beforeEach, expect, it, vi } from "vitest";
import { GET, POST, PUT } from "@/app/api/ontos/enrollment/route";
import { ownerRequest } from "@/ontos/gateway";

vi.mock("@/ontos/gateway", () => ({ ownerRequest: vi.fn<typeof ownerRequest>() }));
const origin = "http://localhost:3070";
const url = `${origin}/api/ontos/enrollment`;
const cookie = "staff.session=private; commerce-portal.session_token=customer";
beforeEach(() => vi.clearAllMocks());

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
    vi.mocked(ownerRequest)
      .mockResolvedValueOnce(Response.json({}, { status: 403 }))
      .mockResolvedValueOnce(Response.json({}, { status }));
    const response = await GET(new Request(url));
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("state");
  },
);

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
