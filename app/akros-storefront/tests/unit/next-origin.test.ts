// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../../next.config";
import { guard, RequestError } from "@/ontos/http";

const origin = "http://127.0.0.1:4925";
const request = (requestOrigin: string) =>
  new NextRequest(`${origin}/api/ontos/account`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: "{}",
  });

afterEach(() => vi.unstubAllEnvs());

describe("Next request origin preservation", () => {
  it("preserves the loopback IP used by the browser without relaxing the origin guard", () => {
    expect(nextConfig.skipProxyUrlNormalize).toBe(true);
    // Next's build defines this flag from skipProxyUrlNormalize for route handlers.
    vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", String(nextConfig.skipProxyUrlNormalize));
    const submitted = request(origin);
    expect(new URL(submitted.url).origin).toBe(origin);
    expect(() => guard(submitted)).not.toThrow();
  });

  it.each(["http://localhost:4925", "http://127.0.0.1:4926", "https://foreign.example.test"])(
    "continues to reject the different origin %s",
    (requestOrigin) => {
      vi.stubEnv("__NEXT_NO_MIDDLEWARE_URL_NORMALIZE", String(nextConfig.skipProxyUrlNormalize));
      expect(() => guard(request(requestOrigin))).toThrow(RequestError);
    },
  );
});
