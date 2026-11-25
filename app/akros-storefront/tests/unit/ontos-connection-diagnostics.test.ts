// @vitest-environment node
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { observeShellConnections } from "@/ontos/connection-diagnostics";

it("counts a real Shell dial and a refusal without touching the response or rejection", async () => {
  const server = createServer((_req, res) => res.end("private payload"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture is not listening");
  const url = `http://localhost:${address.port}`;
  const emit = vi.fn<(event: object) => void>();
  const stop = observeShellConnections(url, emit);
  try {
    expect(await (await fetch(url, { headers: { connection: "close" } })).text()).toBe(
      "private payload",
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(fetch(url)).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
  } finally {
    stop();
    server.closeAllConnections();
    server.close();
  }
  expect(emit.mock.calls[0]?.[0]).toMatchObject({
    node: process.versions.node,
    undici: process.versions.undici,
  });
  expect(emit.mock.calls[1]?.[0]).toMatchObject({
    beforeConnect: 2,
    connected: 1,
    connectError: 1,
    resolvedSockets: 2,
    errorCodes: { ECONNREFUSED: 1 },
  });
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/localhost|127\.0\.0\.1|::1|private payload/);
});

it("keeps origin counts independent of socket samples, bounds output, and releases listeners", () => {
  const secret = "never-print-me.invalid";
  const emit = vi.fn<(event: object) => void>();
  const stop = observeShellConnections(`http://${secret}:3000/secret`, emit);
  const socket = new Socket();
  const wrongPort = new Socket();
  const wrongHost = new Socket();
  const before = channel("undici:client:beforeConnect");
  const failed = channel("undici:client:connectError");
  const params = { protocol: "http:", hostname: secret, port: "3000" };
  const child = (code: string) => Object.assign(Error(secret), { code });
  try {
    for (const [s, host, port] of [
      [socket, secret, 3000],
      [wrongPort, secret, 3001],
      [wrongHost, "other", 3000],
    ] as const) {
      channel("net.client.socket").publish({ socket: s });
      s.emit("lookup", null, "private address", 6, host);
      s.emit("connectionAttempt", "private address", port, 6);
      s.emit("connectionAttemptTimeout", "private address", port, 6);
    }
    socket.emit("close", true);
    before.publish({ connectParams: { ...params, port: "3001" } });
    failed.publish({ connectParams: { ...params, hostname: "other" }, error: child(secret) });
    for (let i = 0; i < 50; i++) before.publish({ connectParams: { ...params } });
    failed.publish({
      connectParams: { ...params },
      error: Object.assign(child("UND_ERR_CONNECT_TIMEOUT"), {
        cause: new AggregateError([child("ETIMEDOUT"), child(secret)], secret),
      }),
    });
    failed.publish({ connectParams: params, error: child("UND_ERR_CONNECT_TIMEOUT") });
    expect(emit).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    stop();
  }
  before.publish({ connectParams: params });
  for (const s of [socket, wrongHost, wrongPort]) {
    for (const event of [
      "lookup",
      "connectionAttempt",
      "connectionAttemptTimeout",
      "connectionAttemptFailed",
      "connect",
      "close",
    ])
      expect(s.listenerCount(event)).toBe(0);
    s.destroy();
  }
  expect(emit).toHaveBeenCalledTimes(2);
  expect(emit.mock.calls[1]?.[0]).toMatchObject({
    beforeConnect: 50,
    connectError: 2,
    resolvedSockets: 1,
    attempts6: 1,
    attemptTimeouts: 1,
    aggregateErrors: 1,
    timeoutsWithNestedAggregate: 1,
    closedBeforeConnect: 1,
    lastFailedDial: {
      lookup4: 0,
      lookup6: 1,
      lastFamily: 6,
      attempts: 1,
      closedMs: expect.any(Number),
    },
    childCodes: { ETIMEDOUT: 1, other: 1 },
    errorCodes: { UND_ERR_CONNECT_TIMEOUT: 2 },
  });
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/never-print|private address|3000|secret/);
});

it("ignores malformed diagnostics and isolates a failing log sink", () => {
  let writes = 0;
  const stop = observeShellConnections("http://fixture.invalid", () => {
    writes++;
    throw Error("private");
  });
  try {
    channel("undici:client:beforeConnect").publish({
      get connectParams() {
        throw Error("private");
      },
    });
    channel("undici:client:beforeConnect").publish({
      connectParams: { hostname: "fixture.invalid", protocol: "http:", port: "" },
    });
  } finally {
    stop();
  }
  expect(writes).toBe(2);
});

it("keeps sampling real connections after synchronously rejected dials fill the registry", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture is not listening");
  const emit = vi.fn<(event: object) => void>();
  const stop = observeShellConnections(`http://localhost:${address.port}`, emit);
  const rejected = Array.from({ length: 256 }, () => new Socket());
  try {
    for (const socket of rejected) {
      expect(() => socket.connect({ host: "localhost", port: -1 })).toThrow();
    }
    expect(
      await (
        await fetch(`http://localhost:${address.port}`, { headers: { connection: "close" } })
      ).text(),
    ).toBe("ok");
  } finally {
    stop();
    for (const socket of rejected) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(emit.mock.calls[1]?.[0]).toMatchObject({
    connected: 1,
    resolvedSockets: 1,
    socketSamplingLimited: true,
  });
  for (const socket of rejected) {
    expect(socket.listenerCount("lookup")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  }
});

it("flushes one active window, not idle windows, and removes pending lookup listeners on stop", () => {
  vi.useFakeTimers();
  const emit = vi.fn<(event: object) => void>();
  const stop = observeShellConnections("http://fixture.invalid", emit);
  const pending = new Socket();
  try {
    channel("net.client.socket").publish({ socket: pending });
    expect(pending.listenerCount("lookup")).toBe(1);
    for (let i = 0; i < 100; i++)
      channel("undici:client:beforeConnect").publish({
        connectParams: { hostname: "fixture.invalid", protocol: "http:", port: "" },
      });
    vi.advanceTimersByTime(30_000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ event: "storefront.connection.defaults" });
    expect(emit.mock.calls[1]?.[0]).toMatchObject({ beforeConnect: 100, resolvedSockets: 0 });
  } finally {
    stop();
    pending.destroy();
    vi.useRealTimers();
  }
  expect(pending.listenerCount("lookup")).toBe(0);
});
