import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellFetch } from "@/ontos/shell-fetch";

const { renderCache } = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { renderCache: new AsyncLocalStorage<Map<unknown, unknown>>() };
});

// React's dispatcher owns this zero-argument cache during an RSC render, not between requests.
vi.mock("react", () => ({
  cache:
    <T>(load: () => T) =>
    () => {
      const values = renderCache.getStore();
      if (values === undefined) return load();
      if (!values.has(load)) values.set(load, load());
      return values.get(load) as T;
    },
}));
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
  it("joins concurrent mints for the same audience within one render", async () => {
    await renderCache.run(new Map(), async () => {
      const results = await Promise.all([
        gateway.readRecords("merchandise", "records", { tree: true }),
        gateway.readRecords("merchandise", "records", { featured: true }),
        gateway.readRecords("merchandise", "records", { slug: "heavy-product" }),
      ]);
      expect(results).toEqual(Array.from({ length: 3 }, () => ({ ok: "Bearer t1" })));
      expect(minted).toBe(1);
      expect(shellFetch).toHaveBeenCalledTimes(4);
    });
  });
  it("never shares pending mints between renders", async () => {
    await Promise.all([
      renderCache.run(new Map(), () => gateway.readRecords("merchandise", "records", {})),
      renderCache.run(new Map(), () => gateway.readRecords("merchandise", "records", {})),
    ]);
    expect(minted).toBe(2);
  });
  it("keeps different audiences separate within a render", async () => {
    await renderCache.run(new Map(), () =>
      Promise.all([
        gateway.readRecords("merchandise", "records", {}),
        gateway.readRecords("pricing", "records", {}),
      ]),
    );
    expect(minted).toBe(2);
  });
  it("drops a failed mint so the same render can retry", async () => {
    vi.mocked(shellFetch).mockResolvedValueOnce(json(503, { code: "gateway_unavailable" }));
    await renderCache.run(new Map(), async () => {
      const results = await Promise.allSettled([
        gateway.callAction("merchandise", "order", {}, "one"),
        gateway.callAction("merchandise", "order", {}, "two"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(shellFetch).toHaveBeenCalledTimes(1);
      expect(await gateway.callAction("merchandise", "order", {}, "retry")).toEqual({
        ok: "Bearer t1",
      });
      expect(shellFetch).toHaveBeenCalledTimes(3);
    });
  });
  it("replaces a rejected assertion at once and retries the read", async () => {
    await renderCache.run(new Map(), async () => {
      await gateway.readRecords("merchandise", "records", {});
      rejectToken = "t1";
      expect(await gateway.readRecords("merchandise", "records", {})).toEqual({ ok: "Bearer t2" });
      expect(minted).toBe(2);
    });
  });
});
