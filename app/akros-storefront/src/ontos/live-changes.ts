import "server-only";
import { getConfig } from "./config";
import { shellFetch } from "./shell-fetch";

// The Shell pushes one invalidation for every owner Action that commits for this storefront's company: the app ids of
// the owners it changed, never data (apps/shell-super-app/api/live-changes). A shared owner answer (fresh-read.ts) stays
// current until the Shell names one of its owners, so an admin save is read again within a second of its commit and a
// visit between saves reads no owner at all. One stream per process, opened with the first shared read: a (re)connect
// counts as a change of every owner, since nothing tells what changed while there was no stream, and while there is none
// a shared answer is trusted only for its time bound.
const LIVE_CHANGES_PATH = "/shell-super-app-api/live-changes";
/** The hub pings every 25 s: a stream silent for longer is gone. */
const SILENCE_MS = 60_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** A stream that stayed open this long ended normally (the hub's 10-minute maximum age): reconnect at once. */
const HEALTHY_MS = 30_000;
const MAX_FRAME = 64_000;

/** Owner app ids of the shop catalogue: every product, Symmy-imported ones included, is a merchandise row. */
export const MERCHANDISE_OWNERS = ["merchandise"] as const;

interface Feed {
  connected: boolean;
  /** When the current stream opened or the hub asked to revalidate everything (ms). */
  everyChangedAt: number;
  /** The newest change of each owner app id (ms). */
  changedAt: Map<string, number>;
  listeners: Set<() => void>;
  running: boolean;
}
// The route handlers and the server components are separate bundles of one process: the stream and its state are
// process-wide.
const FEED = Symbol.for("ontos.akros-storefront.live-changes");
const store = globalThis as typeof globalThis & { [FEED]?: Feed };
const blank = (): Feed => ({
  connected: false,
  everyChangedAt: 0,
  changedAt: new Map(),
  listeners: new Set(),
  running: false,
});
const feed: Feed = (store[FEED] ??= blank());

const notify = () => {
  // A listener removes itself; deleting the visited entry of a Set does not disturb its iteration.
  for (const listener of feed.listeners) listener();
};

/** The newest change of any of `owners` the stream reported (or its connect). */
const changedSince = (owners: readonly string[]) =>
  Math.max(feed.everyChangedAt, ...owners.map((owner) => feed.changedAt.get(owner) ?? 0));

/**
 * An answer whose read started at `startedAt` still holds: the stream is open and reported no change of `owners` after
 * the read started. A change arrives at least 250 ms after its commit (the hub coalesces), so a read that started at its
 * arrival already sees it.
 */
export const isCurrent = (startedAt: number, owners: readonly string[]): boolean =>
  feed.connected && startedAt >= changedSince(owners);

export const liveConnected = (): boolean => feed.connected;

/** Resolves at the next change the stream reports (or its connect or loss), or after `ms`. */
export const nextLiveChange = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      feed.listeners.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    feed.listeners.add(done);
  });

export const setLiveConnected = (connected: boolean, at = Date.now()) => {
  feed.connected = connected;
  if (connected) feed.everyChangedAt = at;
  notify();
};

/** Applies one Server-Sent Events frame of the hub: `: connected`, `event: change` with app ids, or `event: reset`. */
export const applyLiveFrame = (frame: string, at = Date.now()) => {
  let event = "message";
  let data = "";
  let connected = false;
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) {
      connected ||= line.slice(1).trim() === "connected";
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    else if (field === "data") data = data === "" ? value : `${data}\n${value}`;
  }
  if (connected) {
    setLiveConnected(true, at);
    return;
  }
  if (event === "reset") {
    feed.everyChangedAt = at;
  } else if (event === "change") {
    for (const app of data.split(",").map((name) => name.trim()))
      if (app !== "") feed.changedAt.set(app, at);
  } else {
    return;
  }
  notify();
};

/** Tests: forget the stream state (the stream itself runs only in the Next server). */
export const resetLiveChanges = () => {
  const { listeners, running } = feed;
  Object.assign(feed, blank(), { listeners, running });
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/** One stream until it ends: resolves when the hub closes it, rejects when it cannot be opened or goes silent. */
export const followLiveChanges = async (owners: readonly string[]) => {
  const { apiKey, legalEntityId, shellUrl } = getConfig();
  const abort = new AbortController();
  let silence = setTimeout(() => abort.abort(), SILENCE_MS);
  try {
    const response = await shellFetch(`${shellUrl}${LIVE_CHANGES_PATH}`, {
      cache: "no-store",
      redirect: "manual",
      signal: abort.signal,
      headers: {
        accept: "text/event-stream",
        "x-api-key": apiKey ?? "",
        "x-ontos-legal-entity-id": legalEntityId,
        "x-ontos-live-audiences": owners.join(","),
      },
    });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    console.info(`[ontos] live changes stream open for ${owners.join(",")}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      clearTimeout(silence);
      silence = setTimeout(() => abort.abort(), SILENCE_MS);
      buffer += value.replaceAll("\r\n", "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        applyLiveFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
      if (buffer.length > MAX_FRAME) throw new Error("frame too large");
    }
  } finally {
    clearTimeout(silence);
    abort.abort();
    setLiveConnected(false);
  }
};

/** Opens the process's stream once (Next server only; a storefront without its API key has none). */
export const startLiveChanges = () => {
  if (
    feed.running ||
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build" ||
    getConfig().apiKey === undefined
  )
    return;
  feed.running = true;
  void (async () => {
    for (let failures = 0; ;) {
      const openedAt = Date.now();
      let problem: unknown;
      try {
        // Only the owners this storefront shares answers of.
        await followLiveChanges(MERCHANDISE_OWNERS);
      } catch (error) {
        problem = error;
      }
      failures = Date.now() - openedAt >= HEALTHY_MS ? 0 : failures + 1;
      if (failures > 0)
        console.warn(
          `[ontos] live changes stream ${problem === undefined ? "ended" : `failed (${String(problem)})`}; shared answers fall back to their time bound`,
        );
      await pause(failures === 0 ? 0 : Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1)));
    }
  })();
};
