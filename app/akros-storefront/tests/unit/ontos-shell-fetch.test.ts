import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellFetch } from "@/ontos/shell-fetch";

const publicFetch = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", publicFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("Shell transport", () => {
  it("sends the Shell request through fetch with its init unchanged", async () => {
    const response = Response.json({ ok: true });
    publicFetch.mockResolvedValue(response);
    const init = { method: "POST", headers: { "x-api-key": "scoped" }, body: "{}" };
    expect(await shellFetch("http://127.0.0.1:3020/read", init)).toBe(response);
    expect(publicFetch).toHaveBeenCalledWith("http://127.0.0.1:3020/read", init);
  });

  it("surfaces a failed Shell request instead of retrying it", async () => {
    publicFetch.mockRejectedValue(new Error("offline"));
    await expect(shellFetch("https://shell.test/read", {})).rejects.toThrow("offline");
    expect(publicFetch).toHaveBeenCalledTimes(1);
  });
});
