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
let revision = "a".repeat(64);
let redeemed: Set<string>;
beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  gateway = await vi.importActual<Gateway>("@/ontos/gateway");
  minted = 0;
  redeemed = new Set();
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
      if (url.endsWith("gateway-read")) redeemed.add(`Bearer ${context.token}`);
      return url.endsWith("gateway-read")
        ? json(
            200,
            { ok: `Bearer ${context.token}`, query: body.query },
            { "x-ontos-gateway-context": JSON.stringify(context) },
          )
        : json(200, context);
    }
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization === null || redeemed.has(authorization))
      return json(401, { code: "gateway_assertion_replay" });
    redeemed.add(authorization);
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

  it("authenticates every read without replaying the combined read's redeemed assertion", async () => {
    await read({ product: "one" });
    expect(await read({ product: "two" })).toEqual({ ok: "Bearer t2", query: { product: "two" } });
    expect(minted).toBe(2);
    const [url, init] = vi.mocked(shellFetch).mock.calls[1]!;
    expect(url).toBe("https://shell.test/shell-super-app-api/auth/api-key/gateway-read");
    expect(new Headers(init.headers).get("x-api-key")).toBe("key");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(shellFetch).toHaveBeenCalledTimes(2);
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

  it("does not share a failed mint with another action in the same render", async () => {
    vi.mocked(shellFetch).mockResolvedValueOnce(json(503, { code: "gateway_unavailable" }));
    await renderCache.run(new Map(), async () => {
      const results = await Promise.allSettled([
        gateway.callAction("merchandise", "order", {}, "one"),
        gateway.callAction("merchandise", "order", {}, "two"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(shellFetch).toHaveBeenCalledTimes(3);
      await gateway.callAction("merchandise", "order", {}, "retry");
      expect(shellFetch).toHaveBeenCalledTimes(5);
    });
  });

  it.each([400, 401, 409])(
    "replaces a rejected assertion (HTTP %s) and rebinds to the current revision",
    async (status) => {
      await renderCache.run(new Map(), async () => {
        revision = "b".repeat(64);
        vi.mocked(shellFetch).mockResolvedValueOnce(json(status, { code: "assertion_rejected" }));
        expect(await read()).toEqual({ ok: "Bearer t1", query: {} });
        await read();
        expect(vi.mocked(shellFetch).mock.calls.at(-1)![0]).toContain("/auth/api-key/gateway-read");
        expect(minted).toBe(2);
      });
    },
  );

  it("does not retry forbidden reads or serve an earlier result", async () => {
    await read();
    vi.mocked(shellFetch).mockResolvedValueOnce(json(403, { code: "forbidden" }));
    await expect(read()).rejects.toMatchObject({ status: 403 });
    expect(shellFetch).toHaveBeenCalledTimes(2);
  });

  it("mints a fresh action assertion after the cart product read", async () => {
    await read({ productIds: ["real-product"] });
    const payload = { command: { _tag: "PlaceStorefrontOrder", dryRun: true } };
    expect(await gateway.callAction("merchandise", "apply-command", payload, "quote-one")).toEqual({
      ok: "Bearer t2",
      query: payload,
    });
    expect(minted).toBe(2);
    expect(shellFetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(shellFetch).mock.calls[1]![0]).toContain("/auth/api-key/gateway-context");
  });

  it("never lends an action assertion to sequential or concurrent actions or a later read", async () => {
    await renderCache.run(new Map(), async () => {
      await gateway.callAction("merchandise", "apply-command", { first: true }, "first");
      const actions = await Promise.all([
        gateway.callAction("merchandise", "apply-command", { second: true }, "second"),
        gateway.callAction("merchandise", "apply-command", { third: true }, "third"),
      ]);
      expect(actions).toEqual([
        { ok: "Bearer t2", query: { second: true } },
        { ok: "Bearer t3", query: { third: true } },
      ]);
      expect(await read()).toEqual({ ok: "Bearer t4", query: {} });
      const calls = vi
        .mocked(shellFetch)
        .mock.calls.filter(([url]) => url.endsWith("/actions/apply-command"));
      expect(calls.map(([, init]) => new Headers(init.headers).get("idempotency-key"))).toEqual([
        "first",
        "second",
        "third",
      ]);
      expect(minted).toBe(4);
    });
  });

  it("never retries an action after an authentication rejection", async () => {
    const original = vi.mocked(shellFetch).getMockImplementation()!;
    vi.mocked(shellFetch).mockImplementation((url, init) =>
      url.endsWith("/actions/apply-command")
        ? Promise.resolve(json(401, { code: "assertion_rejected" }))
        : original(url, init),
    );
    await expect(
      gateway.callAction("merchandise", "apply-command", {}, "once"),
    ).rejects.toMatchObject({
      status: 401,
    });
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
