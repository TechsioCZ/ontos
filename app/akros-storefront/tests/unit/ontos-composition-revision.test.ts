import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readActiveRevision } from "@/ontos/composition-revision";

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn() }));
const revision = "a".repeat(64);
const snapshot = { composition: { revision } };
const fetchMock = vi.fn();
const context = vi.mocked(getCloudflareContext);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL", "http://127.0.0.1:3041/active");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("active composition revision", () => {
  it("reads the active KV snapshot on Workers without an HTTP request", async () => {
    const get = vi.fn().mockResolvedValue(snapshot);
    context.mockReturnValue({
      cf: undefined,
      ctx: undefined,
      env: { ONTOS_ACTIVE_APPLICATION_COMPOSITION: { get } },
    } as ReturnType<typeof getCloudflareContext>);
    expect(await readActiveRevision()).toBe(revision);
    expect(get).toHaveBeenCalledWith("active", "json");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the HTTP publisher outside Workers", async () => {
    context.mockImplementation(() => {
      throw new Error("No Cloudflare context");
    });
    fetchMock.mockResolvedValue(Response.json(snapshot));
    expect(await readActiveRevision()).toBe(revision);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3041/active", expect.any(Object));
  });

  it("does not fall back to localhost when the bound KV has no snapshot", async () => {
    context.mockReturnValue({
      cf: undefined,
      ctx: undefined,
      env: { ONTOS_ACTIVE_APPLICATION_COMPOSITION: { get: vi.fn().mockResolvedValue(null) } },
    } as ReturnType<typeof getCloudflareContext>);
    expect(await readActiveRevision()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed revisions", async () => {
    context.mockReturnValue({
      cf: undefined,
      ctx: undefined,
      env: {
        ONTOS_ACTIVE_APPLICATION_COMPOSITION: {
          get: vi.fn().mockResolvedValue({ composition: { revision: "bad" } }),
        },
      },
    } as ReturnType<typeof getCloudflareContext>);
    expect(await readActiveRevision()).toBeUndefined();
  });
});
