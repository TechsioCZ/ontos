import { describe, expect, it } from "vitest";
import { withShellTimings } from "@/ontos/server-timing";

const request = new Request("https://storefront.test/");

describe("storefront Shell Server-Timing forwarding", () => {
  it("forwards all fixed numeric owner phases alongside gateway phases", async () => {
    const ownerTimings =
      "read-authentication;dur=0, read-admission;dur=1.25, read-scope;dur=2, read-module;dur=3, read-permission;dur=4, read-prepare;dur=5, read-transaction;dur=6, read-authority;dur=7, read-rls;dur=8, read-owner;dur=9.125, read-validation;dur=10, read-audit;dur=11, read-encode;dur=12";
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, {
              headers: { "server-timing": `${ownerTimings}, owner-dispatch;dur=25` },
            }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response("page");
      },
    );
    expect(response.headers.get("server-timing")).toBe(`${ownerTimings}, owner-dispatch;dur=25`);
  });

  it("forwards owner-only decimal timings but no descriptions, identities or malformed durations", async () => {
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, {
              headers: {
                "server-timing": [
                  " read-owner ; dur=1.25 ",
                  "read-encode;dur=0.0000001",
                  "private-principal;dur=1",
                  "read-private-tenant;dur=2",
                  "isolate-private-id;dur=3",
                  'read-audit;dur=1;desc="private-token"',
                  "read-rls;dur=NaN",
                  "read-rls;dur=Infinity",
                  "read-rls;dur=-1",
                  "read-rls;dur=-0",
                  "read-rls;dur=+1",
                  "read-rls;dur=1e3",
                  "read-rls;dur=0x10",
                  "read-rls;dur=.5",
                  "read-rls;dur=5.",
                  "read-rls;dur=1.2.3",
                  "read-rls;dur=2ms",
                  `read-rls;dur=${"9".repeat(309)}`,
                ].join(", "),
              },
            }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response("page");
      },
    );
    expect(response.headers.get("server-timing")).toBe(
      "read-owner;dur=1.25, read-encode;dur=0.0000001",
    );
  });

  it.each([
    'private;desc="prefix, read-owner;dur=123456, suffix"',
    'read-audit;dur=1;desc="prefix, read-owner;dur=123456, suffix"',
    String.raw`private;desc="escaped \" quote, read-owner;dur=123456, suffix"`,
  ])("never promotes quoted description text into forwarded metrics (%s)", async (description) => {
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, {
              headers: { "server-timing": `${description}, read-encode;dur=2` },
            }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response("page");
      },
    );
    expect(response.headers.get("server-timing")).toBe("read-encode;dur=2");
  });

  it("drops malformed quoted input and unapproved rendered diagnostics even without Shell metrics", async () => {
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, {
              headers: {
                "server-timing": 'private;desc="unclosed, read-owner;dur=123456, read-encode;dur=2',
              },
            }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response("page", {
          headers: {
            "server-timing":
              'render;dur=10, private-principal;dur=1, private;desc="prefix, read-owner;dur=123456, suffix"',
          },
        });
      },
    );
    expect(response.headers.get("server-timing")).toBe("render;dur=10");
  });

  it("bounds the final header including approved existing render metrics", async () => {
    const metric = `read-owner;dur=0.${"0".repeat(8170)}1`;
    expect(metric.length).toBeLessThanOrEqual(8192);
    expect(`render;dur=10, ${metric}`.length).toBeGreaterThan(8192);
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, { headers: { "server-timing": metric } }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response("page", { headers: { "server-timing": "render;dur=10" } });
      },
    );
    expect(response.headers.get("server-timing")).toBe("render;dur=10");
  });

  it("shares the final metric count budget with existing approved render diagnostics", async () => {
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, {
              headers: {
                "server-timing": ["render;dur=999", ...Array(64).fill("read-owner;dur=1")].join(
                  ", ",
                ),
              },
            }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/");
        return new Response("page", { headers: { "server-timing": "render;dur=10" } });
      },
    );
    expect(response.headers.get("server-timing")).toBe(
      ["render;dur=10", ...Array(63).fill("read-owner;dur=1")].join(", "),
    );
  });

  it("rejects oversized rendered headers rather than forwarding arbitrary existing data", async () => {
    const response = await withShellTimings(
      request,
      { ONTOS_SHELL: { fetch: async (_input: RequestInfo | URL) => new Response(null) } },
      {},
      async () =>
        new Response("page", {
          headers: { "server-timing": `render;dur=1, ${"private".repeat(1200)}` },
        }),
    );
    expect(response.headers.get("server-timing")).toBeNull();
  });

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

  it("bounds forwarded bytes across Shell calls even for long finite decimal durations", async () => {
    const metric = `read-owner;dur=0.${"0".repeat(240)}1`;
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (_input: RequestInfo | URL) =>
            new Response(null, { headers: { "server-timing": Array(20).fill(metric).join(", ") } }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/first");
        await env.ONTOS_SHELL.fetch("https://shell.test/second");
        return new Response("page");
      },
    );
    const header = response.headers.get("server-timing") ?? "";
    expect(header.length).toBeGreaterThan(0);
    expect(header.length).toBeLessThanOrEqual(8192);
    expect(header.split(", ").every((entry) => entry === metric)).toBe(true);
  });

  it("rejects oversized upstream timing headers without suppressing a later valid call", async () => {
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (input: RequestInfo | URL) =>
            new Response(null, {
              headers: {
                "server-timing": String(input instanceof Request ? input.url : input).endsWith(
                  "large",
                )
                  ? `read-owner;dur=1, ${"private".repeat(1200)}`
                  : "read-encode;dur=2",
              },
            }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/large");
        await env.ONTOS_SHELL.fetch("https://shell.test/valid");
        return new Response("page");
      },
    );
    expect(response.headers.get("server-timing")).toBe("read-encode;dur=2");
  });

  it("bounds phase count across multiple Shell calls", async () => {
    const response = await withShellTimings(
      request,
      {
        ONTOS_SHELL: {
          fetch: async (input: RequestInfo | URL) =>
            new Response(null, {
              headers: {
                "server-timing": Array(40)
                  .fill(
                    String(input instanceof Request ? input.url : input).endsWith("first")
                      ? "read-owner;dur=1"
                      : "read-encode;dur=2",
                  )
                  .join(", "),
              },
            }),
        },
      },
      {},
      async (_incoming, env) => {
        await env.ONTOS_SHELL.fetch("https://shell.test/first");
        await env.ONTOS_SHELL.fetch("https://shell.test/second");
        return new Response("page");
      },
    );
    expect(response.headers.get("server-timing")).toBe(
      [...Array(40).fill("read-owner;dur=1"), ...Array(24).fill("read-encode;dur=2")].join(", "),
    );
  });

  it.each(["", 'private-principal;dur=1, read-owner;dur=NaN, read-audit;dur=1;desc="private"'])(
    "leaves the response untouched when Shell contributes no valid timings (%s)",
    async (header) => {
      const rendered = new Response("page", { headers: { "server-timing": "render;dur=10" } });
      const response = await withShellTimings(
        request,
        {
          ONTOS_SHELL: {
            fetch: async (_input: RequestInfo | URL) =>
              new Response(null, { headers: { "server-timing": header } }),
          },
        },
        {},
        async (_incoming, env) => {
          await env.ONTOS_SHELL.fetch("https://shell.test/");
          return rendered;
        },
      );
      expect(response).toBe(rendered);
      expect(response.headers.get("server-timing")).toBe("render;dur=10");
    },
  );

  it("leaves responses untouched without a Shell binding and propagates Shell failures", async () => {
    const rendered = new Response("page");
    expect(await withShellTimings(request, {}, {}, async () => rendered)).toBe(rendered);
    const failure = new Error("Shell unavailable");
    await expect(
      withShellTimings(
        request,
        {
          ONTOS_SHELL: {
            fetch: async (_input: RequestInfo | URL): Promise<Response> => {
              throw failure;
            },
          },
        },
        {},
        async (_incoming, env) => {
          await env.ONTOS_SHELL.fetch("https://shell.test/");
          return rendered;
        },
      ),
    ).rejects.toBe(failure);
  });

  it("does not mix concurrent requests or leak timings onto a later cached response", async () => {
    const env = {
      ONTOS_SHELL: {
        fetch: async (input: RequestInfo | URL) =>
          new Response(null, {
            headers: {
              "server-timing": `key-verify;dur=${String(input instanceof Request ? input.url : input).endsWith("first") ? 11 : 22}`,
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
