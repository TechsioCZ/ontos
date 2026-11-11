/**
 * V8 old-space limits for the app host's long-running Node children, derived from the container's memory.
 *
 * Node sizes every process's heap limit by itself (about 1.5 GiB each on stage), so four processes may grow to about
 * twice the container and V8 never collects under pressure: the cgroup throttles at `memory.high` and swaps instead.
 * The host reads the cgroup limit once at start and gives each capped role a fixed share of it. Each share leaves the
 * process's non-heap memory (code, native buffers, sockets; RSS is well above heap) and the other processes room.
 *
 * Shares (MiB of old space at a 2.95 GiB / 4 GiB container):
 * - Shell 25 %, 512..1024 → 752 / 1024. Observed RSS 410–480 MB, so its heap is at most that: ≥ 1.5× headroom.
 * - Outbox worker 25 %, 512..1024 → 752 / 1024. Observed RSS 310–350 MB: ≥ 2.1× headroom; its search rebuilds and
 *   refreshes read in pages, and a heap stop here stops the whole container, so it gets the Shell's share.
 * - Owners: none. Its heap was observed up to 1 GB without evidence of the live set after a full collection, so a
 *   cap could stop all owners; it keeps Node's own limit until that is measured.
 */
import os from 'node:os';

import { Effect, FileSystem, Option, Schema } from 'effect';

const MIB = 1024 * 1024;
/** Whole 16 MiB steps: a limit a few bytes off does not change the flag. */
const STEP_MIB = 16;

export const HeapLimitedRole = Schema.Literals(['outbox', 'shell']);

interface HeapShare {
  readonly maximumMiB: number;
  readonly minimumMiB: number;
  readonly share: number;
}

export const HEAP_SHARES: Readonly<Record<typeof HeapLimitedRole.Type, HeapShare>> = Object.freeze({
  outbox: Object.freeze({ maximumMiB: 1024, minimumMiB: 512, share: 0.25 }),
  shell: Object.freeze({ maximumMiB: 1024, minimumMiB: 512, share: 0.25 }),
});

/** cgroup v2 writes a byte count or the literal `max` (no limit). Anything else is not a limit. */
export const parseCgroupMemoryLimit = (text: string): Option.Option<number> => {
  const value = text.trim();
  if (!/^\d+$/u.test(value)) {
    return Option.none();
  }
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0 ? Option.some(bytes) : Option.none();
};

/**
 * The memory this container may use without being throttled: the lower of `memory.max` and `memory.high`, or the
 * machine's memory when neither is a number (no cgroup v2, or both `max`).
 */
export const containerMemoryBytes = (cgroupFiles: readonly Option.Option<string>[], totalMemoryBytes: number) => {
  const limits = cgroupFiles.flatMap((file) => file.pipe(Option.flatMap(parseCgroupMemoryLimit), Option.toArray));
  return limits.length === 0 ? totalMemoryBytes : Math.min(...limits);
};

export const heapLimitMiB = (role: typeof HeapLimitedRole.Type, memoryBytes: number): number => {
  const { maximumMiB, minimumMiB, share } = HEAP_SHARES[role];
  const steps = Math.floor(((memoryBytes / MIB) * share) / STEP_MIB);
  return Math.min(maximumMiB, Math.max(minimumMiB, steps * STEP_MIB));
};

/** The Node flag for a capped role; it precedes the script so Node, not the script, reads it. */
export const heapLimitArguments = (role: typeof HeapLimitedRole.Type, memoryBytes: number): readonly string[] => [
  `--max-old-space-size=${String(heapLimitMiB(role, memoryBytes))}`,
];

const CGROUP_FILES = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.high'];

/** Read once at host start; an unreadable file is an absent limit. */
export const readContainerMemoryBytes = Effect.gen(function* readContainerMemoryBytes() {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* Effect.forEach(CGROUP_FILES, (file) => fs.readFileString(file).pipe(Effect.option), {
    concurrency: 1,
  });
  return containerMemoryBytes(files, os.totalmem());
});
