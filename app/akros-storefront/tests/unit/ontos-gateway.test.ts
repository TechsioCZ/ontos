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
vi.mock("@/ontos/config", () => ({
  getConfig: () => ({
    apiKey: "key",
    shellUrl: "https://shell.test",
    legalEntityId: "71000000-0000-4000-8000-000000000024",
  }),
}));

type Gateway = typeof import("@/ontos/gateway");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

let gateway: Gateway;
let minted = 0;
let rejectToken: string | undefined;
let rejectionStatus = 401;
let revision = "a".repeat(64);
beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  gateway = await vi.importActual<Gateway>("@/ontos/gateway");
  minted = 0;
  rejectToken = undefined;
  rejectionStatus = 401;
  revision = "a".repeat(64);
  vi.mocked(shellFetch).mockReset();
  vi.mocked(shellFetch).mockImplementation(async (url, init) => {
    if (
      url.endsWith("/auth/api-key/gateway-context") ||
      url.endsWith("/auth/api-key/gateway-read")
    ) {
      minted += 1;
      const body = JSON.parse(String(init.body)) as { audience: string; query?: unknown };
      const context = {
        apiBaseUrl: `/shell-super-app-api/module-api/${body.audience}/r${minted}/${body.audience}-api`,
        compositionRevision: revision,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        token: `t${minted}`,
      };
      return url.endsWith("gateway-read")
        ? json(
            200,
            { ok: `Bearer ${context.token}`, query: body.query },
            { "x-ontos-gateway-context": JSON.stringify(context) },
          )
        : json(200, context);
    }
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization === `Bearer ${rejectToken}`)
      return json(rejectionStatus, { code: "assertion_rejected" });
    return json(200, { ok: authorization, query: JSON.parse(String(init.body)) });
  });
});

const read = (query: unknown = {}) => gateway.readRecords("merchandise", "records", query);

describe("OntOS gateway assertions", () => {
  it("authenticates and reads in one Shell request, without a publisher or a separate mint", async () => {
    expect(await read({ slug: "fresh-product" })).toEqual({
      ok: "Bearer t1",
      query: { slug: "fresh-product" },
    });
    expect(shellFetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(shellFetch).mock.calls[0]!;
    expect(url).toBe("https://shell.test/shell-super-app-api/auth/api-key/gateway-read");
    expect(JSON.parse(String(init.body))).toEqual({
      audience: "merchandise",
      legalEntityId: "71000000-0000-4000-8000-000000000024",
      readName: "records",
      query: { slug: "fresh-product" },
    });
    expect(new Headers(init.headers).get("x-api-key")).toBe("key");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("reuses only the assertion, never a read result, until shortly before expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await read({ product: "one" });
    expect(await read({ product: "two" })).toEqual({ ok: "Bearer t1", query: { product: "two" } });
    expect(minted).toBe(1);
    const [url, init] = vi.mocked(shellFetch).mock.calls[1]!;
    expect(url).toContain("/module-api/merchandise/r1/merchandise-api/reads/records");
    expect(new Headers(init.headers).get("x-api-key")).toBeNull();
    expect(new Headers(init.headers).get("x-ontos-composition-revision")).toBe(revision);
    vi.advanceTimersByTime(239_000);
    await read();
    vi.advanceTimersByTime(2_000);
    expect(await read()).toEqual({ ok: "Bearer t2", query: {} });
    expect(minted).toBe(2);
    expect(shellFetch).toHaveBeenCalledTimes(4);
  });

  it("starts cold owner reads in parallel without waiting for another read's dispatch", async () => {
    const original = vi.mocked(shellFetch).getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(shellFetch).mockImplementation(async (url, init) => {
      const response = await original(url, init);
      const payload = JSON.parse(String(init.body)) as { query?: { tree?: boolean } };
      if (payload.query?.tree) await blocked;
      return response;
    });
    await renderCache.run(new Map(), async () => {
      const tree = read({ tree: true });
      try {
        const featured = await read({ featured: true });
        expect(featured).toEqual({ ok: "Bearer t2", query: { featured: true } });
        expect(minted).toBe(2);
        expect(shellFetch).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(shellFetch).mock.calls.every(([url]) => url.endsWith("gateway-read")),
        ).toBe(true);
      } finally {
        release();
      }
      expect(await tree).toEqual({ ok: "Bearer t1", query: { tree: true } });
    });
  });

  it("never shares pending issuance between renders", async () => {
    await Promise.all([
      renderCache.run(new Map(), () => read()),
      renderCache.run(new Map(), () => read()),
    ]);
    expect(minted).toBe(2);
    expect(shellFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps different audiences separate within a render", async () => {
    await renderCache.run(new Map(), () =>
      Promise.all([read(), gateway.readRecords("pricing", "records", {})]),
    );
    expect(minted).toBe(2);
  });

  it("binds action issuance to the Shell's active revision with no client revision", async () => {
    await gateway.callAction("merchandise", "order", {}, "one");
    const [, init] = vi.mocked(shellFetch).mock.calls[0]!;
    expect(JSON.parse(String(init.body))).toEqual({
      audience: "merchandise",
      legalEntityId: "71000000-0000-4000-8000-000000000024",
    });
    expect(
      new Headers(vi.mocked(shellFetch).mock.calls[1]![1].headers).get("idempotency-key"),
    ).toBe("one");
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
      await gateway.callAction("merchandise", "order", {}, "retry");
      expect(shellFetch).toHaveBeenCalledTimes(3);
    });
  });

  it.each([400, 401, 409])(
    "replaces a rejected assertion (HTTP %s) and rebinds to the current revision",
    async (status) => {
      await renderCache.run(new Map(), async () => {
        await read();
        rejectToken = "t1";
        rejectionStatus = status;
        revision = "b".repeat(64);
        expect(await read()).toEqual({ ok: "Bearer t2", query: {} });
        await read();
        expect(
          new Headers(vi.mocked(shellFetch).mock.calls.at(-1)![1].headers).get(
            "x-ontos-composition-revision",
          ),
        ).toBe(revision);
        expect(minted).toBe(2);
      });
    },
  );

  it("does not retry forbidden reads or serve an earlier result", async () => {
    await read();
    rejectToken = "t1";
    rejectionStatus = 403;
    await expect(read()).rejects.toMatchObject({ status: 403 });
    expect(shellFetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a successful combined response without assertion metadata", async () => {
    vi.mocked(shellFetch).mockResolvedValue(json(200, { stale: "must not be returned" }));
    await expect(read()).rejects.toMatchObject({ status: 502, code: "gateway_context_malformed" });
  });

  it("rejects path traversal before sending credentials", async () => {
    await expect(gateway.readRecords("merchandise", "../actions/order", {})).rejects.toThrow(
      "Invalid path segment",
    );
    expect(shellFetch).not.toHaveBeenCalled();
  });
});
