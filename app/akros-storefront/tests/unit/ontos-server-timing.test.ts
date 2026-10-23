import { describe, expect, it } from "vitest";
import { withShellTimings } from "@/ontos/server-timing";

const request = new Request("https://storefront.test/");

describe("storefront Shell Server-Timing forwarding", () => {
  it("forwards only allowlisted numeric phases, preserving the body, status and other headers", async () => {
    const shell = new Response("owner", {
      headers: {
        "server-timing":
          'legal-entity-sql;dur=24, legal-entity-spicedb;dur=80, owner-dispatch;dur=1256, private-user;dur=1, key-verify;dur=2;desc="secret", assertion-issue;dur=NaN',
        "x-ontos-gateway-context": "private-assertion",
      },
    });
    const response = await withShellTimings(
      request,
      { ONTOS_SHELL: { fetch: async (_input: RequestInfo | URL) => shell } },
      {},
      async (_request, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response("rendered", {
          status: 201,
          headers: {
            "cache-control": "no-store",
            "set-cookie": "session=opaque; HttpOnly",
            "server-timing": "render;dur=10",
          },
        });
      },
    );
    expect(response.headers.get("server-timing")).toBe(
      "render;dur=10, legal-entity-sql;dur=24, legal-entity-spicedb;dur=80, owner-dispatch;dur=1256",
    );
    expect(response.headers.get("x-ontos-gateway-context")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBe("session=opaque; HttpOnly");
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("rendered");
  });

  it("does not mix concurrent requests or leak timings onto a later cached response", async () => {
    const env = {
      ONTOS_SHELL: {
        fetch: async (input: RequestInfo | URL) =>
          new Response(null, {
            headers: {
              "server-timing": `key-verify;dur=${String(input).endsWith("first") ? 11 : 22}`,
            },
          }),
      },
    };
    const handle = async (incoming: Request, scoped: typeof env) => {
      await scoped.ONTOS_SHELL.fetch(incoming.url);
      return new Response("page");
    };
    const responses = await Promise.all(
      ["first", "second"].map((path) =>
        withShellTimings(new Request(`https://storefront.test/${path}`), env, {}, handle),
      ),
    );
    expect(responses.map((response) => response.headers.get("server-timing"))).toEqual([
      "key-verify;dur=11",
      "key-verify;dur=22",
    ]);
    expect(
      (await withShellTimings(request, env, {}, async () => new Response("cached"))).headers.get(
        "server-timing",
      ),
    ).toBeNull();
  });

  it("does not buffer streaming HTML while collecting diagnostics", async () => {
    let finish!: () => void;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        finish = () => controller.close();
      },
    });
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, { headers: { "server-timing": "owner-dispatch;dur=1" } }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response(stream);
      },
    );
    expect(response.body).toBe(stream);
    expect(response.headers.get("server-timing")).toBe("owner-dispatch;dur=1");
    finish();
  });
});
