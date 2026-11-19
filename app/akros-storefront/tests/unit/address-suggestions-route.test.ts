// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAddressSuggestionsHandler } from "@/app/api/address-suggestions/handler";
import { GET } from "@/app/api/address-suggestions/route";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

async function call(
  handler: ReturnType<typeof createAddressSuggestionsHandler>,
  url: string,
  init?: RequestInit,
) {
  const context = nextRequest(url, init);
  try {
    return await context.run(() => handler(context.request));
  } finally {
    await context.close();
  }
}

const query = "q=Brno&countryCode=CZ&countryCodes=CZ&kind=address&language=cs&limit=20";

describe("same-origin address transport", () => {
  it("never forwards deployment cookies, authorization or arbitrary query options upstream", async () => {
    let redirect = false;
    let displayLabel = "Brno";
    const upstream = await serveHttp((request) => {
      if (redirect && new URL(request.url).pathname === "/api/v1/suggest")
        return Response.redirect(new URL("/redirect-target", request.url), 302);
      return Response.json(
        { suggestions: [{ id: "1", displayLabel, address: { city: "Brno" } }] },
        {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "Set-Cookie": "provider=private; Path=/",
          },
        },
      );
    });
    try {
      const handler = createAddressSuggestionsHandler(`${upstream.origin}/api/v1/suggest`);
      const url =
        "https://any-preview.example/api/address-suggestions?q=Brno&url=https://evil.example&limit=999";
      const init = {
        headers: {
          Cookie: "preview=private",
          Authorization: "Bearer private",
          "X-Preview-Secret": "private",
        },
      };
      const response = await call(handler, url, init);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toEqual({
        suggestions: [{ id: "1", displayLabel: "Brno", address: { city: "Brno" } }],
      });
      await upstream.idle();
      expect(upstream.requests).toHaveLength(1);
      const [request] = upstream.requests;
      expect(request.url).toBe(`${upstream.origin}/api/v1/suggest?${query}`);
      expect(request.method).toBe("GET");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-preview-secret")).toBeNull();
      // Native server fetch serializes no-store as an upstream cache bypass.
      expect(request.headers.get("cache-control")).toBe("no-cache");
      expect(request.headers.get("pragma")).toBe("no-cache");

      // Even a publicly cacheable upstream response cannot make a later lookup stale.
      displayLabel = "Brno-střed";
      const fresh = await call(handler, url, init);
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("cache-control")).toBe("no-store");
      expect(await fresh.json()).toEqual({
        suggestions: [{ id: "1", displayLabel: "Brno-střed", address: { city: "Brno" } }],
      });
      await upstream.idle();
      expect(upstream.requests).toHaveLength(2);
      expect(upstream.requests[1].headers.get("cookie")).toBeNull();

      // Redirect rejection must prevent the target from receiving any request.
      redirect = true;
      const refused = await call(handler, url, init);
      expect(refused.status).toBe(502);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      await upstream.idle();
      expect(upstream.requests.map((sent) => sent.url)).toEqual([
        `${upstream.origin}/api/v1/suggest?${query}`,
        `${upstream.origin}/api/v1/suggest?${query}`,
        `${upstream.origin}/api/v1/suggest?${query}`,
      ]);
    } finally {
      await upstream.close();
    }
  });

  it("rejects invalid queries without contacting the provider", async () => {
    const upstream = await serveHttp(() => Response.json({ suggestions: [] }));
    try {
      // Establish a real arrival before checking that invalid inputs send nothing.
      expect((await fetch(`${upstream.origin}/ready`)).status).toBe(200);
      const handler = createAddressSuggestionsHandler(`${upstream.origin}/api/v1/suggest`);
      for (const input of ["", "ab", "a".repeat(301), "Bratislava&countryCode=SK"]) {
        const url = `https://preview.example/api/address-suggestions?q=${input}`;
        expect((await call(handler, url)).status).toBe(400);
        // The production route export uses the same validation and native signature.
        expect((await call(GET, url)).status).toBe(400);
      }
      await upstream.idle();
      expect(upstream.requests.map((request) => new URL(request.url).pathname)).toEqual(["/ready"]);
    } finally {
      await upstream.close();
    }
  });

  it.each(["outage", "html", "malformed", "network"])(
    "returns a non-cacheable error for %s",
    async (failure) => {
      const upstream = await serveHttp(() =>
        failure === "outage"
          ? new Response("offline", { status: 503 })
          : failure === "html"
            ? new Response("<html>login</html>")
            : Response.json({ invalid: true }),
      );
      let closed = false;
      try {
        if (failure === "network") {
          // Prove this was a live local endpoint, then actually take it offline.
          expect((await fetch(`${upstream.origin}/ready`)).status).toBe(200);
          await upstream.idle();
          await upstream.close();
          closed = true;
        }
        const handler = createAddressSuggestionsHandler(`${upstream.origin}/api/v1/suggest`);
        const response = await call(
          handler,
          "https://preview.example/api/address-suggestions?q=Brno",
        );
        expect(response.status).toBe(502);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ error: "Address service unavailable" });
        if (failure !== "network") {
          await upstream.idle();
          expect(upstream.requests.map((request) => request.url)).toEqual([
            `${upstream.origin}/api/v1/suggest?${query}`,
          ]);
        }
      } finally {
        if (!closed) await upstream.close();
      }
    },
  );
});
