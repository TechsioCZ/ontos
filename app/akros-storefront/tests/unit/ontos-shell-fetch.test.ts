import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { shellFetch } from "@/ontos/shell-fetch";

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn() }));
const publicFetch = vi.fn();
const context = vi.mocked(getCloudflareContext);
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", publicFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("Shell transport", () => {
  it("uses the configured service binding in Workers, preserving its receiver and request", async () => {
    const response = Response.json({ ok: true });
    const binding = {
      fetch: vi.fn(function (this: unknown) {
        expect(this).toBe(binding);
        return Promise.resolve(response);
      }),
    };
    context.mockReturnValue({ env: { ONTOS_SHELL: binding } } as unknown as ReturnType<
      typeof getCloudflareContext
    >);
    const init = { method: "POST", headers: { "x-api-key": "scoped" }, body: "{}" };
    expect(await shellFetch("https://shell.test/read", init)).toBe(response);
    expect(binding.fetch).toHaveBeenCalledWith("https://shell.test/read", init);
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("never silently sends Worker traffic through a public hostname when its binding is missing", async () => {
    context.mockReturnValue({ env: {} } as ReturnType<typeof getCloudflareContext>);
    await expect(shellFetch("https://shell.test/read", {})).rejects.toThrow(
      "ONTOS_SHELL service binding is not configured",
    );
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("does not fall back to a public hostname when a bound service fails", async () => {
    context.mockReturnValue({
      env: { ONTOS_SHELL: { fetch: vi.fn().mockRejectedValue(new Error("offline")) } },
    } as unknown as ReturnType<typeof getCloudflareContext>);
    await expect(shellFetch("https://shell.test/read", {})).rejects.toThrow("offline");
    expect(publicFetch).not.toHaveBeenCalled();
  });

  it("uses the Shell URL for a plain local Next.js server without Worker context", async () => {
    context.mockImplementation(() => {
      throw new Error("No Cloudflare context");
    });
    publicFetch.mockResolvedValue(Response.json({ ok: true }));
    await shellFetch("http://127.0.0.1:3020/read", { method: "POST" });
    expect(publicFetch).toHaveBeenCalledWith("http://127.0.0.1:3020/read", { method: "POST" });
  });
});
