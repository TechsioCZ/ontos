// @vitest-environment node
import { spawn } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gateway from "@/ontos/gateway";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const storefront = fileURLToPath(new NodeURL("../../", import.meta.url));
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Node's react-server condition selects the real server cache. Next's RSC renderer
// installs the dispatcher; request stores alone and ordinary SSR do not do that.
// Only TypeScript is bundled. React and the renderer remain native dependencies.
async function render(
  operation: string,
  checkpoint: (value: unknown) => void | Promise<void> = () => {},
  renderCount = 1,
): Promise<{ value: unknown; renderKeys: string[] }> {
  const bundle = await build({
    stdin: {
      resolveDir: storefront,
      contents: `
        import * as gateway from './src/ontos/gateway';
        import * as React from 'react';
        import { randomUUID } from 'node:crypto';
        import { renderToReadableStream } from 'next/dist/compiled/react-server-dom-webpack/server.node';
        import { nextRequest } from './tests/support/next-request';
        const read = (query = {}) => gateway.readRecords('merchandise', 'records', query);
        const cached = React.cache(randomUUID);
        const checkpoint = (value) => new Promise(resolve => {
          process.once('message', resolve);
          process.send({kind: 'checkpoint', value});
        });
        async function renderOne() {
          const request = nextRequest();
          return request.run(async () => {
            let result;
            async function Probe() {
              const renderKey = cached();
              if (renderKey !== cached()) throw new Error('Missing real RSC cache dispatcher');
              result = { value: await (async () => { ${operation} })(), renderKey };
              return 'gateway render complete';
            }
            try {
              const stream = await renderToReadableStream(React.createElement(Probe), {}, {
                onError(error) { throw error; }
              });
              const payload = await new Response(stream).text();
              if (!payload.includes('gateway render complete')) throw new Error(payload);
              return result;
            } finally { await request.close(); }
          });
        }
        Promise.all(Array.from({length: ${renderCount}}, renderOne)).then(results => {
          process.send({kind: 'result',
            value: ${renderCount} === 1 ? results[0].value : results.map(result => result.value),
            renderKeys: results.map(result => result.renderKey)
          });
        }).catch(error => {
          process.send({kind: 'error', message: String(error?.stack ?? error)});
        }).finally(() => process.disconnect());
      `,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["react", "react-dom", "next/*"],
    // Same Next-owned empty marker as the existing Vitest configuration.
    alias: {
      "server-only": fileURLToPath(
        new NodeURL("../../node_modules/next/dist/compiled/server-only/empty.js", import.meta.url),
      ),
    },
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("Missing RSC entry bundle");
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", "--input-type=commonjs", "-e", output.text],
    {
      cwd: storefront,
      env: process.env,
      signal: AbortSignal.timeout(10_000),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    return await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        reject(new Error(`RSC exited (${code}): ${stderr}`));
      });
      child.on("message", async (message) => {
        if (typeof message !== "object" || message === null || !("kind" in message)) return;
        if (message.kind === "checkpoint" && "value" in message) {
          try {
            await checkpoint(message.value);
            child.send({ kind: "continue" });
          } catch (error) {
            reject(error);
          }
        } else if (
          message.kind === "result" &&
          "renderKeys" in message &&
          Array.isArray(message.renderKeys) &&
          message.renderKeys.every((key) => typeof key === "string")
        ) {
          resolve({
            value: "value" in message ? message.value : undefined,
            renderKeys: message.renderKeys,
          });
        } else if (message.kind === "error" && "message" in message) {
          reject(new Error(String(message.message)));
        }
      });
    });
  } finally {
    child.kill();
  }
}

let network: Awaited<ReturnType<typeof serveHttp>>;
let context: ReturnType<typeof nextRequest>;
let minted = 0;
let revision = "a".repeat(64);
let redeemed: Set<string>;
let responses: Response[];
let actionFailure: Response | undefined;
let always: (() => Response) | undefined;
let blockedTree: ReturnType<typeof deferred> | undefined;
let pendingRenders: ReturnType<typeof deferred> | undefined;

beforeEach(async () => {
  minted = 0;
  redeemed = new Set();
  responses = [];
  actionFailure = undefined;
  always = undefined;
  blockedTree = undefined;
  pendingRenders = undefined;
  revision = "a".repeat(64);
  network = await serveHttp(async (request) => {
    if (always) return always();
    const queued = responses.shift();
    if (queued) return queued;
    const path = new URL(request.url).pathname;
    if (
      path.endsWith("/auth/api-key/gateway-context") ||
      path.endsWith("/auth/api-key/gateway-read")
    ) {
      minted += 1;
      const body = await request.json();
      const assertion = {
        apiBaseUrl: `/shell-super-app-api/module-api/${body.audience}/r${minted}/${body.audience}-api`,
        compositionRevision: revision,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        token: `t${minted}`,
      };
      if (path.endsWith("gateway-read")) {
        redeemed.add(`Bearer ${assertion.token}`);
        if (minted === 2) pendingRenders?.resolve();
        await pendingRenders?.promise;
        if (body.query?.tree) await blockedTree?.promise;
        return json(
          200,
          { ok: `Bearer ${assertion.token}`, query: body.query },
          { "x-ontos-gateway-context": JSON.stringify(assertion) },
        );
      }
      return json(200, assertion);
    }
    if (actionFailure) return actionFailure;
    const authorization = request.headers.get("authorization");
    if (authorization === null || redeemed.has(authorization))
      return json(401, { code: "gateway_assertion_replay" });
    redeemed.add(authorization);
    return json(200, { ok: authorization, query: await request.json() });
  });
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "key");
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000024");
  context = nextRequest();
});
afterEach(async () => {
  blockedTree?.resolve();
  pendingRenders?.resolve();
  await context.close();
  await network.close();
  vi.unstubAllEnvs();
});
const read = (query: unknown = {}) =>
  context.run(() => gateway.readRecords("merchandise", "records", query));
const action = (...args: Parameters<typeof gateway.callAction>) =>
  context.run(() => gateway.callAction(...args));
const requestAt = (index: number) => {
  const request = network.requests[index];
  if (!request) throw new Error(`Missing HTTP request ${index}`);
  return request;
};

describe("OntOS gateway assertions", () => {
  it("authenticates and reads in one Shell request, without a publisher or a separate mint", async () => {
    expect(await read({ slug: "fresh-product" })).toEqual({
      ok: "Bearer t1",
      query: { slug: "fresh-product" },
    });
    await network.idle();
    expect(network.requests).toHaveLength(1);
    const request = requestAt(0);
    expect(request.url).toBe(`${network.origin}/shell-super-app-api/auth/api-key/gateway-read`);
    expect(await request.json()).toEqual({
      audience: "merchandise",
      legalEntityId: "71000000-0000-4000-8000-000000000024",
      readName: "records",
      query: { slug: "fresh-product" },
    });
    expect(request.headers.get("x-api-key")).toBe("key");
    expect(request.headers.get("authorization")).toBeNull();
  });
  it("authenticates every read without replaying the combined read's redeemed assertion", async () => {
    await read({ product: "one" });
    expect(await read({ product: "two" })).toEqual({ ok: "Bearer t2", query: { product: "two" } });
    await network.idle();
    expect(minted).toBe(2);
    const request = requestAt(1);
    expect(request.url).toBe(`${network.origin}/shell-super-app-api/auth/api-key/gateway-read`);
    expect(request.headers.get("x-api-key")).toBe("key");
    expect(request.headers.get("authorization")).toBeNull();
    expect(network.requests).toHaveLength(2);
  });
  it("starts cold owner reads in parallel without waiting for another read's dispatch", async () => {
    blockedTree = deferred();
    try {
      const result = await render(
        `
        const tree = read({ tree: true });
        const featured = await read({ featured: true });
        await checkpoint(featured);
        return await tree;
      `,
        (featured) => {
          // Completed featured HTTP response signals arrival while tree stays blocked.
          try {
            expect(featured).toEqual({ ok: "Bearer t2", query: { featured: true } });
            expect(minted).toBe(2);
            expect(network.requests).toHaveLength(2);
            expect(network.requests.every((request) => request.url.endsWith("gateway-read"))).toBe(
              true,
            );
          } finally {
            blockedTree?.resolve();
          }
        },
      );
      expect(result.value).toEqual({ ok: "Bearer t1", query: { tree: true } });
    } finally {
      blockedTree.resolve();
    }
  });
  it("never shares pending issuance between renders", async () => {
    pendingRenders = deferred();
    const renders = await render("return await read();", () => {}, 2);
    await network.idle();
    expect(minted).toBe(2);
    expect(network.requests).toHaveLength(2);
    expect(renders.renderKeys).toHaveLength(2);
    expect(renders.renderKeys[0]).not.toBe(renders.renderKeys[1]);
  });
  it("keeps different audiences separate within a render", async () => {
    await render(
      `return await Promise.all([read(), gateway.readRecords('pricing', 'records', {})]);`,
    );
    await network.idle();
    expect(minted).toBe(2);
  });
  it("binds action issuance to the Shell's active revision with no client revision", async () => {
    await action("merchandise", "order", {}, "one");
    await network.idle();
    expect(await requestAt(0).json()).toEqual({
      audience: "merchandise",
      legalEntityId: "71000000-0000-4000-8000-000000000024",
    });
    expect(requestAt(1).headers.get("idempotency-key")).toBe("one");
  });
  it("does not share a failed mint with another action in the same render", async () => {
    responses.push(json(503, { code: "gateway_unavailable" }));
    await render(
      `
      const results = await Promise.allSettled([
        gateway.callAction('merchandise', 'order', {}, 'one'),
        gateway.callAction('merchandise', 'order', {}, 'two'),
      ]);
      await checkpoint(results.map(result => result.status));
      await gateway.callAction('merchandise', 'order', {}, 'retry');
    `,
      async (statuses) => {
        expect(statuses).toEqual(["rejected", "fulfilled"]);
        await network.idle();
        expect(network.requests).toHaveLength(3);
      },
    );
    await network.idle();
    expect(network.requests).toHaveLength(5);
  });
  it.each([400, 401, 409])(
    "replaces a rejected assertion (HTTP %s) and rebinds to the current revision",
    async (status) => {
      revision = "b".repeat(64);
      responses.push(json(status, { code: "assertion_rejected" }));
      await render(`await checkpoint(await read()); await read();`, (value) => {
        expect(value).toEqual({ ok: "Bearer t1", query: {} });
      });
      await network.idle();
      expect(network.requests.at(-1)?.url).toContain("/auth/api-key/gateway-read");
      expect(minted).toBe(2);
    },
  );
  it("waits out a deploy handoff of several unavailable responses before serving the read", async () => {
    for (let index = 0; index < 6; index += 1)
      responses.push(json(503, { code: "backend_unreachable" }));
    expect(await read({ slug: "during-deploy" })).toMatchObject({
      query: { slug: "during-deploy" },
    });
  }, 25_000);
  it("gives up on a read once the unavailable budget is spent", async () => {
    always = () => json(503, { code: "backend_unreachable" });
    expect(await read().catch((error: unknown) => error)).toMatchObject({ status: 503 });
    await network.idle();
    const readCalls = network.requests.filter((request) =>
      request.url.endsWith("/auth/api-key/gateway-read"),
    ).length;
    expect(readCalls).toBeGreaterThan(3);
    expect(readCalls).toBeLessThan(20);
  }, 45_000);
  it("does not retry forbidden reads or serve an earlier result", async () => {
    await read();
    responses.push(json(403, { code: "forbidden" }));
    await expect(read()).rejects.toMatchObject({ status: 403 });
    await network.idle();
    expect(network.requests).toHaveLength(2);
  });
  it("mints a fresh action assertion after the cart product read", async () => {
    await read({ productIds: ["real-product"] });
    const payload = { command: { _tag: "PlaceStorefrontOrder", dryRun: true } };
    expect(await action("merchandise", "apply-command", payload, "quote-one")).toEqual({
      ok: "Bearer t2",
      query: payload,
    });
    await network.idle();
    expect(minted).toBe(2);
    expect(network.requests).toHaveLength(3);
    expect(requestAt(1).url).toContain("/auth/api-key/gateway-context");
  });
  it("never lends an action assertion to sequential or concurrent actions or a later read", async () => {
    const result = await render(
      `
      await gateway.callAction('merchandise', 'apply-command', { first: true }, 'first');
      const actions = await Promise.all([
        gateway.callAction('merchandise', 'apply-command', { second: true }, 'second'),
        gateway.callAction('merchandise', 'apply-command', { third: true }, 'third'),
      ]);
      await checkpoint(actions);
      return await read();
    `,
      (actions) => {
        expect(actions).toEqual([
          { ok: "Bearer t2", query: { second: true } },
          { ok: "Bearer t3", query: { third: true } },
        ]);
      },
    );
    expect(result.value).toEqual({ ok: "Bearer t4", query: {} });
    await network.idle();
    const calls = network.requests.filter((request) =>
      request.url.endsWith("/actions/apply-command"),
    );
    expect(calls.map((request) => request.headers.get("idempotency-key"))).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(minted).toBe(4);
  });
  it("never retries an action after an authentication rejection", async () => {
    actionFailure = json(401, { code: "assertion_rejected" });
    await expect(action("merchandise", "apply-command", {}, "once")).rejects.toMatchObject({
      status: 401,
    });
    await network.idle();
    expect(network.requests).toHaveLength(2);
  });
  it("fails closed on a successful combined response without assertion metadata", async () => {
    always = () => json(200, { stale: "must not be returned" });
    await expect(read()).rejects.toMatchObject({ status: 502, code: "gateway_context_malformed" });
  });
  it("rejects path traversal before sending credentials", async () => {
    await expect(
      context.run(() => gateway.readRecords("merchandise", "../actions/order", {})),
    ).rejects.toThrow("Invalid path segment");
    await network.idle();
    expect(network.requests).toHaveLength(0);
  });
});
