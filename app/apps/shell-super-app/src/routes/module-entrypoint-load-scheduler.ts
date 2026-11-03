import type { InstalledDeploymentFailureReason } from '@app/core-runtime';
import { Cause, Clock, Deferred, Duration, Effect, Schema } from 'effect';

export type SettledModuleEntrypointLoad<Value> =
  | {
      readonly reason: InstalledDeploymentFailureReason;
      readonly state: 'unavailable';
    }
  | { readonly state: 'ready'; readonly value: Value };

export type IdentifiedSettledModuleEntrypointLoad<Identity, Value> = SettledModuleEntrypointLoad<Value> & {
  readonly identity: Identity;
};

/** Bound for independent external module loads so one navigation cannot fan out without limit. */
export const MODULE_LOAD_CONCURRENCY = 8;

export interface ModuleEntrypointLoadIdentity {
  readonly artifact: string;
  readonly owner: string;
  readonly result: string;
}

/** Parsed external module namespace only; each caller owns the schema for its requested export. */
export const ModuleEntrypointNamespaceSchema = Schema.Union([Schema.ObjectKeyword, Schema.Null]);
export type ModuleEntrypointNamespace = typeof ModuleEntrypointNamespaceSchema.Type;
export type ModuleEntrypointLoadFailure = Cause.UnknownError | Schema.SchemaError;

export interface ModuleEntrypointLoadRequest<Identity, Value> {
  readonly contract: Schema.Decoder<Value>;
  readonly identity: Identity;
  readonly load: () => Effect.Effect<ModuleEntrypointNamespace, ModuleEntrypointLoadFailure>;
  readonly loadIdentity: ModuleEntrypointLoadIdentity;
  readonly timeoutMs?: number;
}

const timeoutResult = { reason: 'timeout', state: 'unavailable' } as const;
const unavailableResult = { reason: 'unavailable', state: 'unavailable' } as const;
const incompatibleResult = { reason: 'incompatible', state: 'unavailable' } as const;
const MODULE_OWNER_LOAD_CONCURRENCY = 2;

type RawModuleLoadResult =
  | { readonly state: 'ready'; readonly value: ModuleEntrypointNamespace }
  | typeof unavailableResult
  | typeof incompatibleResult;

interface ModuleLoadWaiter {
  active: boolean;
  readonly deadline: number;
}

interface SharedModuleLoad {
  readonly identity: ModuleEntrypointLoadIdentity;
  readonly load: () => Effect.Effect<ModuleEntrypointNamespace, ModuleEntrypointLoadFailure>;
  readonly result: Deferred.Deferred<RawModuleLoadResult>;
  started: boolean;
  readonly waiters: Set<ModuleLoadWaiter>;
}

interface JoinedModuleLoad {
  readonly job: SharedModuleLoad;
  readonly waiter: ModuleLoadWaiter;
}

interface PendingModuleCaller<Identity, Value> {
  readonly deadline: number;
  readonly joined: JoinedModuleLoad | undefined;
  readonly request: ModuleEntrypointLoadRequest<Identity, Value>;
}

const validateCallerResult = <Value>(
  raw: RawModuleLoadResult,
  contract: Schema.Decoder<Value>,
): Effect.Effect<SettledModuleEntrypointLoad<Value>> => {
  if (raw.state === 'unavailable') {
    return Effect.succeed(raw);
  }
  // The synchronous contract boundary also captures remote export getters; schema issues stay typed.
  return Effect.try({
    catch: (cause) => new Cause.UnknownError(cause, 'Module entrypoint namespace contract inspection failed'),
    try: () => Schema.decodeUnknownResult(contract)(raw.value),
  }).pipe(
    Effect.flatMap(Effect.fromResult),
    Effect.map((value): SettledModuleEntrypointLoad<Value> => ({ state: 'ready', value })),
    Effect.catchTags({
      SchemaError: () => Effect.succeed(incompatibleResult),
      UnknownError: () => Effect.succeed(incompatibleResult),
    }),
  );
};

/** One browser runtime accounts for SDK operations, not caller-visible timeouts. */
class BrowserModuleLoadScheduler {
  private readonly jobs = new Map<string, SharedModuleLoad>();
  private readonly queues = new Map<string, SharedModuleLoad[]>();
  private readonly owners: string[] = [];
  private readonly runningByOwner = new Map<string, number>();
  private running = 0;

  private join<Identity, Value>(
    request: ModuleEntrypointLoadRequest<Identity, Value>,
    deadline: number,
  ): JoinedModuleLoad | undefined {
    const identity = request.loadIdentity;
    let job = this.jobs.get(identity.result);
    if (job !== undefined && (job.identity.owner !== identity.owner || job.identity.artifact !== identity.artifact)) {
      return undefined;
    }
    if (job === undefined) {
      job = {
        identity,
        load: request.load,
        result: Deferred.makeUnsafe<RawModuleLoadResult>(),
        started: false,
        waiters: new Set(),
      };
      this.jobs.set(identity.result, job);
      const queued = this.queues.get(identity.owner);
      if (queued === undefined) {
        this.queues.set(identity.owner, [job]);
        this.owners.push(identity.owner);
      } else {
        queued.push(job);
      }
    }
    const waiter: ModuleLoadWaiter = { active: true, deadline };
    job.waiters.add(waiter);
    return { job, waiter };
  }

  private retainLiveWaiters(job: SharedModuleLoad, now: number): boolean {
    for (const waiter of job.waiters) {
      if (!waiter.active || now >= waiter.deadline) {
        waiter.active = false;
        job.waiters.delete(waiter);
      }
    }
    if (job.waiters.size > 0) {
      return true;
    }
    if (this.jobs.get(job.identity.result) === job) {
      this.jobs.delete(job.identity.result);
    }
    return false;
  }

  private takeNext(now: number): SharedModuleLoad | undefined {
    const candidates = this.owners.length;
    for (let scanned = 0; scanned < candidates; scanned += 1) {
      const owner = this.owners.shift();
      if (owner === undefined) {
        return undefined;
      }
      const queue = (this.queues.get(owner) ?? []).filter((job) => this.retainLiveWaiters(job, now));
      if (queue.length === 0) {
        this.queues.delete(owner);
      } else if ((this.runningByOwner.get(owner) ?? 0) >= MODULE_OWNER_LOAD_CONCURRENCY) {
        this.queues.set(owner, queue);
        this.owners.push(owner);
      } else {
        this.queues.set(owner, queue);
        const job = queue.shift();
        if (queue.length > 0) {
          this.owners.push(owner);
        } else {
          this.queues.delete(owner);
        }
        if (job !== undefined) {
          job.started = true;
          this.running += 1;
          this.runningByOwner.set(owner, (this.runningByOwner.get(owner) ?? 0) + 1);
          return job;
        }
      }
    }
    return undefined;
  }

  private finish(job: SharedModuleLoad): void {
    this.running -= 1;
    const remaining = (this.runningByOwner.get(job.identity.owner) ?? 1) - 1;
    if (remaining === 0) {
      this.runningByOwner.delete(job.identity.owner);
    } else {
      this.runningByOwner.set(job.identity.owner, remaining);
    }
    if (this.jobs.get(job.identity.result) === job) {
      this.jobs.delete(job.identity.result);
    }
  }

  private pump(): Effect.Effect<void> {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        Effect.sync(() => {
          const ready: SharedModuleLoad[] = [];
          while (this.running < MODULE_LOAD_CONCURRENCY) {
            const job = this.takeNext(now);
            if (job === undefined) {
              break;
            }
            ready.push(job);
          }
          return ready;
        }),
      ),
      Effect.flatMap((ready) =>
        Effect.forEach(ready, (job) => Effect.forkDetach(this.run(job)), { concurrency: 1, discard: true }),
      ),
      Effect.uninterruptible,
    );
  }

  private run(job: SharedModuleLoad): Effect.Effect<void> {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Effect.sync(() => this.retainLiveWaiters(job, now))),
      Effect.flatMap((live): Effect.Effect<RawModuleLoadResult> =>
        live
          ? Effect.suspend(job.load).pipe(
              Effect.map((value): RawModuleLoadResult => ({ state: 'ready', value })),
              Effect.catchTags({
                SchemaError: () => Effect.succeed(incompatibleResult),
                UnknownError: () => Effect.succeed(unavailableResult),
              }),
            )
          : Effect.succeed(unavailableResult),
      ),
      Effect.flatMap((raw) => Deferred.succeed(job.result, raw)),
      Effect.asVoid,
      Effect.ensuring(Effect.sync(() => this.finish(job)).pipe(Effect.andThen(() => this.pump()))),
      Effect.uninterruptible,
    );
  }

  private leave(joined: JoinedModuleLoad): void {
    const { job, waiter } = joined;
    waiter.active = false;
    job.waiters.delete(waiter);
    if (!job.started && job.waiters.size === 0) {
      if (this.jobs.get(job.identity.result) === job) {
        this.jobs.delete(job.identity.result);
      }
      const queue = (this.queues.get(job.identity.owner) ?? []).filter((queued) => queued !== job);
      if (queue.length === 0) {
        this.queues.delete(job.identity.owner);
        const turn = this.owners.indexOf(job.identity.owner);
        if (turn !== -1) {
          this.owners.splice(turn, 1);
        }
      } else {
        this.queues.set(job.identity.owner, queue);
      }
    }
  }

  private awaitCaller<Identity, Value>({
    deadline,
    joined,
    request,
  }: PendingModuleCaller<Identity, Value>): Effect.Effect<IdentifiedSettledModuleEntrypointLoad<Identity, Value>> {
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now): Effect.Effect<SettledModuleEntrypointLoad<Value>> => {
        if (now >= deadline) {
          return Effect.succeed(timeoutResult);
        }
        if (joined === undefined) {
          return Effect.succeed(unavailableResult);
        }
        return Deferred.await(joined.job.result).pipe(
          Effect.flatMap((raw) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((settledAt) =>
                settledAt >= deadline ? Effect.succeed(timeoutResult) : validateCallerResult(raw, request.contract),
              ),
            ),
          ),
          Effect.timeout(Duration.millis(deadline - now)),
          Effect.catchTag('TimeoutError', () => Effect.succeed(timeoutResult)),
        );
      }),
      Effect.map((result) => ({ ...result, identity: request.identity })),
      Effect.ensuring(
        joined === undefined
          ? Effect.void
          : Effect.sync(() => this.leave(joined)).pipe(Effect.andThen(() => this.pump())),
      ),
    );
  }

  readonly settle = <Identity, Value>(
    loads: readonly ModuleEntrypointLoadRequest<Identity, Value>[],
  ): Effect.Effect<readonly IdentifiedSettledModuleEntrypointLoad<Identity, Value>[]> =>
    Effect.acquireUseRelease(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((startedAt) =>
          Effect.sync(() =>
            loads.map((request) => {
              const deadline = startedAt + (request.timeoutMs ?? 5000);
              return { deadline, joined: deadline > startedAt ? this.join(request, deadline) : undefined, request };
            }),
          ),
        ),
      ),
      (pending) =>
        this.pump().pipe(
          Effect.andThen(
            Effect.forEach(pending, (caller) => this.awaitCaller(caller), { concurrency: Math.max(pending.length, 1) }),
          ),
        ),
      (pending) =>
        Effect.sync(() => {
          for (const { joined } of pending) {
            if (joined !== undefined) {
              this.leave(joined);
            }
          }
        }).pipe(Effect.andThen(() => this.pump())),
    );
}

/** Isolated tests use the same fixed limits; production callers share the single runtime instance below. */
export const makeModuleEntrypointLoadScheduler = () => {
  const scheduler = new BrowserModuleLoadScheduler();
  return { settle: scheduler.settle };
};

const browserModuleLoadScheduler = makeModuleEntrypointLoadScheduler();

/** In-flight code sharing never shares a caller's authorization, deadline or compatibility result. */
export const settleModuleEntrypointLoads = browserModuleLoadScheduler.settle;
