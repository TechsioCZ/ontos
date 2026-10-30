import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/address-suggestions/route";

describe("same-origin address transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never forwards deployment cookies, authorization or arbitrary query options upstream", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        suggestions: [{ id: "1", displayLabel: "Brno", address: { city: "Brno" } }],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(
      new Request(
        "https://any-preview.example/api/address-suggestions?q=Brno&url=https://evil.example&limit=999",
        { headers: { Cookie: "preview=private", Authorization: "Bearer private" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      "https://smart-suggest-shell-super-app.edution.workers.dev/api/v1/suggest?q=Brno&countryCode=CZ&countryCodes=CZ&kind=address&language=cs&limit=20",
    );
    expect(options?.headers).toEqual({ Accept: "application/json" });
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    expect(options?.cache).toBe("no-store");
    expect(await response.json()).toEqual({
      suggestions: [{ id: "1", displayLabel: "Brno", address: { city: "Brno" } }],
    });
  });

  it("rejects invalid queries without contacting the provider", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    for (const query of ["", "ab", "a".repeat(301)]) {
      expect(
        (await GET(new Request(`https://preview.example/api/address-suggestions?q=${query}`)))
          .status,
      ).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["outage", "html", "malformed", "network"])(
    "returns a non-cacheable error for %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        failure === "network"
          ? vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))
          : vi
              .fn<typeof fetch>()
              .mockResolvedValue(
                failure === "outage"
                  ? new Response("offline", { status: 503 })
                  : failure === "html"
                    ? new Response("<html>login</html>")
                    : Response.json({ invalid: true }),
              ),
      );
      const response = await GET(
        new Request("https://preview.example/api/address-suggestions?q=Brno"),
      );
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
});
