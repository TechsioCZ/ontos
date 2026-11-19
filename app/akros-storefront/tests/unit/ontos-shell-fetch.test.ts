import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { shellFetch } from "@/ontos/shell-fetch";
import { browserAt, serveHttp } from "../support/http";

describe("Shell transport", () => {
  it("sends the Shell request through fetch with its init unchanged", async () => {
    const network = await serveHttp(() =>
      Response.json({ ok: true }, { headers: { "x-shell-response": "read" } }),
    );
    browserAt(network.origin);
    try {
      const init = { method: "POST", headers: { "x-api-key": "scoped" }, body: "{}" };
      const response = await shellFetch(`${network.origin}/read`, init);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-shell-response")).toBe("read");
      expect(await response.json()).toEqual({ ok: true });
      await network.idle();
      expect(network.requests).toHaveLength(1);
      const [request] = network.requests;
      expect(request.url).toBe(`${network.origin}/read`);
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-api-key")).toBe("scoped");
      expect(await request.text()).toBe("{}");
      expect(init).toEqual({ method: "POST", headers: { "x-api-key": "scoped" }, body: "{}" });
    } finally {
      await network.close();
    }
  });

  it("surfaces a failed Shell request instead of retrying it", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
      const origin = `http://127.0.0.1:${address.port}`;
      browserAt(origin);
      const arrived = once(server, "request");
      await expect(shellFetch(`${origin}/read`, {})).rejects.toThrow("socket hang up");
      await arrived;
      await setImmediate();
      await setImmediate();
      expect(requests).toEqual(["GET /read"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
