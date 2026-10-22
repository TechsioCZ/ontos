import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellFetch } from "@/ontos/shell-fetch";

vi.mock("server-only", () => ({}));
vi.mock("@/ontos/shell-fetch", () => ({ shellFetch: vi.fn() }));
vi.mock("@/ontos/composition-revision", () => ({
  readActiveRevision: vi.fn(async () => "a".repeat(64)),
}));
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({
    apiKey: "key",
    shellUrl: "https://shell.test",
    legalEntityId: "71000000-0000-4000-8000-000000000024",
    compositionUrl: "http://publisher.test/active",
    compositionRevision: undefined,
  }),
}));

type Gateway = typeof import("@/ontos/gateway");
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let gateway: Gateway;
let minted = 0;
let rejectToken: string | undefined;
beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  gateway = await vi.importActual<Gateway>("@/ontos/gateway");
  minted = 0;
  rejectToken = undefined;
  vi.mocked(shellFetch).mockReset();
  vi.mocked(shellFetch).mockImplementation(async (url, init) => {
    if (url.endsWith("/auth/api-key/gateway-context")) {
      minted += 1;
      return json(200, {
        apiBaseUrl: "/shell-super-app-api/module-api/merchandise/r1/merchandise-api",
        compositionRevision: "a".repeat(64),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        token: `t${minted}`,
      });
    }
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization === `Bearer ${rejectToken}`) return json(401, { code: "unauthorized" });
    return json(200, { ok: authorization });
  });
});

describe("OntOS gateway assertions", () => {
  it("reuses one assertion per audience until shortly before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(await gateway.readRecords("merchandise", "records", {})).toEqual({ ok: "Bearer t1" });
    expect(await gateway.readRecords("merchandise", "records", {})).toEqual({ ok: "Bearer t1" });
    expect(minted).toBe(1);
    vi.advanceTimersByTime(239_000);
    expect(await gateway.readRecords("merchandise", "records", {})).toEqual({ ok: "Bearer t1" });
    vi.advanceTimersByTime(2_000);
    expect(await gateway.readRecords("merchandise", "records", {})).toEqual({ ok: "Bearer t2" });
    expect(minted).toBe(2);
  });
  it("replaces a rejected assertion at once and retries the read", async () => {
    await gateway.readRecords("merchandise", "records", {});
    rejectToken = "t1";
    expect(await gateway.readRecords("merchandise", "records", {})).toEqual({ ok: "Bearer t2" });
    expect(minted).toBe(2);
  });
});
