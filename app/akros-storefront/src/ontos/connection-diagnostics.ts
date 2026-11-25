import { channel } from "node:diagnostics_channel";
import { getDefaultResultOrder } from "node:dns";
import {
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  Socket,
} from "node:net";

const codes = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const code = (error: unknown) => {
  const value = record(error) && error.code;
  return typeof value === "string" && codes.has(value) ? value : "other";
};
const counts = (): Record<string, number> => ({});
type FailedDial = {
  lookupMs: number;
  lookup4: number;
  lookup6: number;
  firstAttemptMs: number;
  lastFamily: 0 | 4 | 6;
  attempts: number;
  closedMs: number;
};
const counters = () => ({
  beforeConnect: 0,
  connected: 0,
  connectError: 0,
  aggregateErrors: 0,
  timeoutsWithNestedAggregate: 0,
  childCodesOmitted: 0,
  errorCodes: counts(),
  childCodes: counts(),
  resolvedSockets: 0,
  attempts4: 0,
  attempts6: 0,
  attemptTimeouts: 0,
  attemptFailures: 0,
  tcpConnected: 0,
  closedBeforeConnect: 0,
  maxLookupMs: 0,
  maxAttemptTimeoutMs: 0,
  maxAttemptFailureMs: 0,
  maxTcpConnectMs: 0,
});
const origin = (value: string | undefined) => {
  const url = value && URL.parse(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return;
  return {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[|\]$/gu, ""),
    urlPort: url.port,
    port: Number(url.port || (url.protocol === "http:" ? 80 : 443)),
  };
};

/** The two populations are independent: Undici publishes by origin; net reveals a dial's host at lookup and port at attempt. */
export function observeShellConnections(
  shellUrl: string | undefined,
  emit: (event: object) => void = (event) => console.info(JSON.stringify(event)),
) {
  const target = origin(shellUrl);
  const write = (event: object) => {
    try {
      emit(event);
    } catch {
      /* Diagnostics must not interrupt the transport. */
    }
  };
  write({
    event: "storefront.connection.defaults",
    node: process.versions.node,
    undici: process.versions.undici,
    dnsOrder: getDefaultResultOrder(),
    autoSelectFamily: getDefaultAutoSelectFamily(),
    attemptTimeoutMs: getDefaultAutoSelectFamilyAttemptTimeout(),
    targetConfigured: !!target,
  });
  if (!target) return () => {};

  let current: ReturnType<typeof counters> | undefined;
  let lastFailedDial: FailedDial | undefined;
  let socketSamplingLimited = false;
  const activity = () => (current ??= counters());
  let since = performance.now();
  const flush = () => {
    const now = performance.now();
    if (current) {
      write({
        event: "storefront.connection.window",
        windowMs: Math.round(now - since),
        ...current,
        lastFailedDial,
        socketSamplingLimited,
      });
    }
    current = undefined;
    lastFailedDial = undefined;
    socketSamplingLimited = false;
    since = now;
  };
  const pending = new Set<() => void>();
  const watchSocket = (socket: Socket) => {
    if (pending.size >= 256) {
      socketSamplingLimited = true;
      // A synchronous connect rejection need not emit close. Keep the bounded
      // sample rolling instead of letting abandoned dials starve every new one.
      pending.values().next().value?.();
    }
    const start = performance.now();
    const age = () => Math.round(performance.now() - start);
    let lookupMs: number | undefined;
    let lookup4 = 0;
    let lookup6 = 0;
    let attempts = 0;
    let firstAttemptMs = 0;
    let lastFamily: 0 | 4 | 6 = 0;
    const lookup = (error: unknown, _address: unknown, family: unknown, hostname: unknown) => {
      if (hostname !== target.hostname || error) {
        remove();
        return;
      }
      lookupMs ??= age();
      if (family === 4) lookup4++;
      if (family === 6) lookup6++;
    };
    const attempt = (_address: unknown, port: unknown, family: unknown) => {
      if (port !== target.port || lookupMs === undefined) {
        remove();
        return;
      }
      const window = activity();
      if (attempts++ === 0) {
        firstAttemptMs = age();
        window.resolvedSockets++;
        window.maxLookupMs = Math.max(window.maxLookupMs, lookupMs);
      }
      lastFamily = family === 4 || family === 6 ? family : 0;
      if (family === 4) window.attempts4++;
      if (family === 6) window.attempts6++;
    };
    const timeout = () => {
      if (!attempts) return;
      const window = activity();
      window.attemptTimeouts++;
      window.maxAttemptTimeoutMs = Math.max(window.maxAttemptTimeoutMs, age());
    };
    const failed = () => {
      if (!attempts) return;
      const window = activity();
      window.attemptFailures++;
      window.maxAttemptFailureMs = Math.max(window.maxAttemptFailureMs, age());
    };
    const connected = () => {
      if (attempts) {
        const window = activity();
        window.tcpConnected++;
        window.maxTcpConnectMs = Math.max(window.maxTcpConnectMs, age());
      }
      remove();
    };
    const closed = () => {
      if (lookupMs !== undefined && attempts > 0) {
        const window = activity();
        window.closedBeforeConnect++;
        lastFailedDial = {
          lookupMs,
          lookup4,
          lookup6,
          firstAttemptMs,
          lastFamily,
          attempts,
          closedMs: age(),
        };
      }
      remove();
    };
    function remove() {
      socket
        .off("lookup", lookup)
        .off("connectionAttempt", attempt)
        .off("connectionAttemptTimeout", timeout)
        .off("connectionAttemptFailed", failed)
        .off("connect", connected)
        .off("close", closed);
      pending.delete(remove);
    }
    pending.add(remove);
    socket
      .on("lookup", lookup)
      .on("connectionAttempt", attempt)
      .on("connectionAttemptTimeout", timeout)
      .on("connectionAttemptFailed", failed)
      .on("connect", connected)
      .on("close", closed);
  };
  const subscriptions = [
    "undici:client:beforeConnect",
    "undici:client:connected",
    "undici:client:connectError",
    "net.client.socket",
  ].map((name) => {
    const source = channel(name);
    const receive = (message: unknown) => {
      try {
        if (!record(message)) return;
        if (name === "net.client.socket") {
          if (message.socket instanceof Socket) watchSocket(message.socket);
          return;
        }
        const params = message.connectParams;
        if (
          !record(params) ||
          params.protocol !== target.protocol ||
          params.hostname !== target.hostname ||
          params.port !== target.urlPort
        )
          return;
        const window = activity();
        if (name === "undici:client:beforeConnect") {
          window.beforeConnect++;
          return;
        }
        if (name === "undici:client:connected") {
          window.connected++;
          return;
        }
        window.connectError++;
        const error = message.error;
        const key = code(error);
        window.errorCodes[key] = (window.errorCodes[key] ?? 0) + 1;
        const aggregate =
          record(error) && error.cause instanceof AggregateError ? error.cause : error;
        if (!(aggregate instanceof AggregateError)) return;
        window.aggregateErrors++;
        if (key === "UND_ERR_CONNECT_TIMEOUT" && aggregate !== error)
          window.timeoutsWithNestedAggregate++;
        const children: unknown = aggregate.errors;
        if (!Array.isArray(children)) return;
        window.childCodesOmitted += Math.max(0, children.length - 16);
        for (let i = 0; i < Math.min(children.length, 16); i++) {
          const key = code(children[i]);
          window.childCodes[key] = (window.childCodes[key] ?? 0) + 1;
        }
      } catch {
        /* Ignore malformed publications; never serialize or rethrow native data. */
      }
    };
    source.subscribe(receive);
    return () => source.unsubscribe(receive);
  });
  const interval = setInterval(flush, 10_000).unref();
  return () => {
    clearInterval(interval);
    for (const unsubscribe of subscriptions) unsubscribe();
    for (const remove of pending) remove();
    flush();
  };
}
