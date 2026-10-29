#!/usr/bin/env node
// Garbage collector of the immutable stage release Workers. Every release uploads a content-addressed
// ontos-<56 hex>/assets-<56 hex> pair, nothing else deletes one, and the account allows only 500 Workers. The pruner
// keeps every Worker something may still serve or reuse and deletes the others:
//   - every Worker the active Application Composition names (read from its provider storage, as publication does),
//   - every Worker this run's composition candidate names,
//   - every Worker of the receipts the release ledger carries forward (so a later plan can retain or reupload them),
//   - every service binding target of the account's other Workers (the Shell ingress binds approved releases),
//   - both Workers of every release any of these names, and every release created within the grace window (an
//     upload in flight has no receipt yet).
// Nothing is deleted when the active composition cannot be read. Only names of exactly the immutable shape are ever
// candidates, so the Shell ingress, the storefront and every other Worker are never touched.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Clock,
  Config,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Result,
  Schedule,
  Schema,
  Semaphore,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import { decodeActiveApplicationCompositionSnapshot } from '../active-application-composition.mts';
import { deleteImmutableWorker } from '../immutable-application-release.mts';
import {
  ApplicationCompositionPublicationCandidateSchema,
  readPublishedSnapshot,
} from '../publish-active-application-composition.mts';
import { DIGEST_VERSION, LEDGER_LOOKBACK } from './deploy-plan.mts';
import { carriedUnitRecords, createGitHubClient, parseLedger, readTrustedLedgers } from './release-ledger.mts';
import type { ReleaseLedger } from './release-ledger.mts';

export class PruneImmutableWorkersError extends Schema.TaggedError<PruneImmutableWorkersError>()(
  'PruneImmutableWorkersError',
  { cause: Schema.optional(Schema.Defect()), message: Schema.String },
) {}

const fail = (message: string) => (cause?: unknown) => new PruneImmutableWorkersError({ cause, message });

/** The exact name shape of an immutable release Worker; nothing else is ever deleted. */
export const IMMUTABLE_WORKER_NAME = /^(?:ontos|assets)-[\da-f]{56}$/u;
const MENTIONED_WORKER = /(?<![\w-])(?:ontos|assets)-[\da-f]{56}(?![\da-f])/gu;
/** A release created this recently may belong to an upload still in flight, which has no receipt yet. */
export const PRUNE_GRACE = Duration.hours(2);
/** The account count (with this release's new Workers) a release may reach; the provider stops at 500. */
export const SAFE_WORKER_CEILING = 450;

/** Every immutable release Worker a document names. */
export const mentionedImmutableWorkers = (text: string): ReadonlySet<string> => new Set(text.match(MENTIONED_WORKER));

/** Both Workers of one release share their identity; they are kept or deleted together. */
const releaseIdentity = (name: string) => name.slice(name.indexOf('-') + 1);
const backendFirst = (name: string) => (name.startsWith('ontos-') ? 0 : 1);

export interface AccountWorker {
  /** Epoch milliseconds. */
  readonly createdOn: number;
  /** Epoch milliseconds. */
  readonly modifiedOn: number;
  readonly name: string;
}

/** Why a release stays, in the order a release is attributed to its first reason. */
export const KEEP_REASONS = ['active', 'candidate', 'ledger', 'binding', 'grace'] as const;
export type KeepReason = (typeof KEEP_REASONS)[number];

export interface KeepSources {
  /** Named by the active Application Composition. */
  readonly active: ReadonlySet<string>;
  /** Service binding targets of the account's other Workers. */
  readonly binding: ReadonlySet<string>;
  /** Named by this run's composition candidate. */
  readonly candidate: ReadonlySet<string>;
  /** Named by a receipt the release ledger carries. */
  readonly ledger: ReadonlySet<string>;
}

export interface PruneRelease {
  /** Epoch milliseconds of its oldest Worker. */
  readonly createdOn: number;
  /** Its present Workers, the backend before its assets Worker (a backend may reference its assets, never back). */
  readonly workers: readonly string[];
}

export interface PrunePlan {
  readonly accountWorkers: number;
  readonly immutableWorkers: number;
  /** Kept immutable Workers by their first reason. */
  readonly kept: Readonly<Record<KeepReason, number>>;
  /** Unreferenced releases, oldest first. */
  readonly releases: readonly PruneRelease[];
}

/** Which account Workers stay and which unreferenced immutable releases go. */
export const planImmutableWorkerPrune = ({
  grace,
  keep,
  now,
  workers,
}: {
  readonly grace: Duration.Duration;
  readonly keep: KeepSources;
  /** Epoch milliseconds. */
  readonly now: number;
  readonly workers: readonly AccountWorker[];
}): PrunePlan => {
  const immutable = workers.filter(({ name }) => IMMUTABLE_WORKER_NAME.test(name));
  const reasons = new Map<string, KeepReason>();
  const attribute = (identity: string, reason: KeepReason) => {
    if (!reasons.has(identity)) {
      reasons.set(identity, reason);
    }
  };
  for (const reason of KEEP_REASONS) {
    if (reason !== 'grace') {
      for (const name of keep[reason]) {
        if (IMMUTABLE_WORKER_NAME.test(name)) {
          attribute(releaseIdentity(name), reason);
        }
      }
    }
  }
  const graceMillis = Duration.toMillis(grace);
  for (const worker of immutable) {
    if (now - Math.max(worker.createdOn, worker.modifiedOn) < graceMillis) {
      attribute(releaseIdentity(worker.name), 'grace');
    }
  }
  const kept = { active: 0, binding: 0, candidate: 0, grace: 0, ledger: 0 } satisfies Record<KeepReason, number>;
  const releases = new Map<string, { createdOn: number; workers: string[] }>();
  for (const worker of immutable) {
    const identity = releaseIdentity(worker.name);
    const reason = reasons.get(identity);
    if (reason === undefined) {
      const release = releases.get(identity) ?? { createdOn: worker.createdOn, workers: [] };
      release.createdOn = Math.min(release.createdOn, worker.createdOn);
      release.workers.push(worker.name);
      releases.set(identity, release);
    } else {
      kept[reason] += 1;
    }
  }
  return {
    accountWorkers: workers.length,
    immutableWorkers: immutable.length,
    kept,
    releases: [...releases.entries()]
      .toSorted(([left, a], [right, b]) => a.createdOn - b.createdOn || left.localeCompare(right))
      .map(([, release]) => ({
        createdOn: release.createdOn,
        workers: release.workers.toSorted((left, right) => backendFirst(left) - backendFirst(right)),
      })),
  };
};

/** The oldest unreferenced releases whose Workers add up to at least `count`. */
export const oldestReleasesFreeing = (releases: readonly PruneRelease[], count: number): PruneRelease[] => {
  const chosen: PruneRelease[] = [];
  let freed = 0;
  for (const release of releases) {
    if (freed >= count) {
      break;
    }
    chosen.push(release);
    freed += release.workers.length;
  }
  return chosen;
};

const provider = Effect.gen(function* cloudflareProvider() {
  const [accountId, token] = yield* Effect.all([
    Config.String('CLOUDFLARE_ACCOUNT_ID'),
    Config.Redacted('CLOUDFLARE_API_TOKEN'),
  ]);
  if (!/^[a-f\d]{32}$/u.test(accountId)) {
    return yield* fail('pruning requires an exact Cloudflare account')();
  }
  return { accountId, token };
});

/** One read-only provider GET, repeated briefly while the provider answers nothing about it. */
const readProvider = <A,>(token: Redacted.Redacted, url: string, schema: Schema.Codec<A, unknown>, refusal: string) =>
  Effect.gen(function* readProviderEffect() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.bearerToken(HttpClientRequest.get(url), Redacted.value(token)))
      .pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.filterOrFail(
          (answer) => answer.status !== 429 && answer.status < 500,
          () => fail(refusal)(),
        ),
        Effect.retry({ schedule: Schedule.exponential('2 seconds'), times: 3 }),
      );
    if (response.status !== 200) {
      return yield* fail(`${refusal} (HTTP ${String(response.status)})`)();
    }
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json);
  }).pipe(Effect.mapError((cause) => (Schema.is(PruneImmutableWorkersError)(cause) ? cause : fail(refusal)(cause))));

const AccountScriptsSchema = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      created_on: Schema.DateTimeUtcFromString,
      id: Schema.String,
      modified_on: Schema.DateTimeUtcFromString,
    }),
  ),
  success: Schema.Literal(true),
});

/** Every Worker of the account. The provider answers the whole account in one list. */
export const listAccountWorkers = Effect.gen(function* listAccountWorkersEffect() {
  const { accountId, token } = yield* provider;
  const scripts = yield* readProvider(
    token,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    AccountScriptsSchema,
    'the account Workers could not be listed',
  );
  // An unreadable age would hide an upload in flight from the grace window, so the list must decode whole.
  return scripts.result.map((script): AccountWorker => ({
    createdOn: DateTime.toEpochMillis(script.created_on),
    modifiedOn: DateTime.toEpochMillis(script.modified_on),
    name: script.id,
  }));
});

const ScriptSettingsSchema = Schema.Struct({
  result: Schema.Struct({
    bindings: Schema.Array(Schema.Struct({ service: Schema.optionalKey(Schema.String), type: Schema.String })),
  }),
  success: Schema.Literal(true),
});

const boundService = (binding: (typeof ScriptSettingsSchema.Type)['result']['bindings'][number]) =>
  binding.type === 'service' && binding.service !== undefined ? [binding.service] : [];

/** The Workers every non-immutable Worker of the account binds as a service. */
const serviceBindingTargets = (workers: readonly AccountWorker[]) =>
  Effect.gen(function* serviceBindingTargetsEffect() {
    const { accountId, token } = yield* provider;
    const settings = yield* Effect.forEach(
      workers.filter(({ name }) => !IMMUTABLE_WORKER_NAME.test(name)),
      ({ name }) =>
        readProvider(
          token,
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/settings`,
          ScriptSettingsSchema,
          `the service bindings of ${name} could not be read`,
        ),
      { concurrency: 4 },
    );
    return new Set(settings.flatMap(({ result }) => result.bindings.flatMap(boundService)));
  });

/** The Workers the active Application Composition names. Unreadable or absent, nothing may be pruned. */
export const activeCompositionWorkers = Effect.gen(function* activeCompositionWorkersEffect() {
  const stored = yield* readPublishedSnapshot.pipe(
    Effect.mapError(fail('the active Application Composition could not be read; nothing is pruned')),
  );
  if (Option.isNone(stored)) {
    return yield* fail('no active Application Composition is published; nothing is pruned')();
  }
  yield* decodeActiveApplicationCompositionSnapshot(stored.value).pipe(
    Effect.mapError(fail('the active Application Composition does not decode; nothing is pruned')),
  );
  const named = mentionedImmutableWorkers(stored.value);
  if (named.size === 0) {
    return yield* fail('the active Application Composition names no immutable Worker; nothing is pruned')();
  }
  return named;
});

const candidateWorkers = (file: string) =>
  Effect.gen(function* candidateWorkersEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(file);
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationCompositionPublicationCandidateSchema))(text);
    return mentionedImmutableWorkers(text);
  }).pipe(Effect.mapError(fail(`the composition candidate ${file} could not be read; nothing is pruned`)));

/** The Workers of every receipt a merge of these ledgers carries forward: exactly what a later plan may reuse. */
export const ledgerWorkers = (ledgers: readonly ReleaseLedger[], now: Date): ReadonlySet<string> =>
  new Set(
    Object.values(carriedUnitRecords(ledgers, { digestVersion: DIGEST_VERSION, now })).flatMap(({ receipt }) => [
      receipt.plan.backendScriptName,
      receipt.plan.assetsScriptName,
    ]),
  );

const readLedgerFile = (file: string) =>
  Effect.gen(function* readLedgerFileEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(file);
    return yield* Effect.try({ catch: (cause) => cause, try: () => parseLedger(text) });
  }).pipe(Effect.mapError(fail(`the release ledger ${file} could not be read; nothing is pruned`)));

const readLedgers = (files: readonly string[], trusted: boolean) =>
  Effect.gen(function* readLedgersEffect() {
    const fromFiles = yield* Effect.forEach(files, readLedgerFile, { concurrency: 'unbounded' });
    if (!trusted) {
      return fromFiles;
    }
    const [repository, githubToken, apiUrl] = yield* Effect.all([
      Config.String('GITHUB_REPOSITORY'),
      Config.Redacted('GH_TOKEN'),
      Config.String('GITHUB_API_URL').pipe(Config.withDefault('https://api.github.com')),
    ]);
    const client = createGitHubClient({
      apiUrl,
      fetch: fetch.bind(globalThis),
      repository,
      token: Redacted.value(githubToken),
    });
    const fromRuns = yield* Effect.tryPromise({
      catch: fail('the trusted release ledgers could not be read; nothing is pruned'),
      try: async () => await readTrustedLedgers(client, LEDGER_LOOKBACK),
    });
    return [...fromFiles, ...fromRuns];
  });

export interface KeepOptions {
  readonly candidateFile: Option.Option<string>;
  readonly ledgerFiles: readonly string[];
  readonly trustedLedgers: boolean;
}

/** Every source of {@link KeepSources}, each read fail-closed. */
const readKeepSources = (workers: readonly AccountWorker[], options: KeepOptions) =>
  Effect.gen(function* readKeepSourcesEffect() {
    const now = yield* DateTime.nowAsDate;
    const [active, candidate, ledgers, binding] = yield* Effect.all(
      [
        activeCompositionWorkers,
        Option.match(options.candidateFile, {
          onNone: () => Effect.succeed<ReadonlySet<string>>(new Set()),
          onSome: candidateWorkers,
        }),
        readLedgers(options.ledgerFiles, options.trustedLedgers),
        serviceBindingTargets(workers),
      ],
      { concurrency: 'unbounded' },
    );
    if (ledgers.length === 0) {
      yield* Effect.logWarning('no release ledger was found: only the compositions, bindings and grace keep Workers');
    }
    return { active, binding, candidate, ledger: ledgerWorkers(ledgers, now) } satisfies KeepSources;
  });

/** Provider requests one proven deletion makes: the DELETE and the read that proves it. */
const REQUESTS_PER_DELETION = 2;

/**
 * Spaces deletion starts across every concurrent deletion so that at most `requestsPerSecond` provider requests start
 * a second, below the provider's account API rate limit (1,200 requests in five minutes): a prune never locks the
 * release out of the provider.
 */
const deletionPacer = (requestsPerSecond: number) =>
  Effect.gen(function* deletionPacerEffect() {
    const gate = yield* Semaphore.make(1);
    const spacing = Math.ceil((REQUESTS_PER_DELETION * 1000) / requestsPerSecond);
    let next = 0;
    return gate.withPermits(1)(
      Effect.gen(function* paceDeletion() {
        const now = yield* Clock.currentTimeMillis;
        const start = Math.max(now, next);
        next = start + spacing;
        yield* Effect.sleep(Duration.millis(start - now));
      }),
    );
  });

export interface DeletionSettings {
  readonly concurrency: number;
  readonly requestsPerSecond: number;
  /** No release starts its deletion after this long; the next prune continues. */
  readonly timeBudget: Duration.Duration;
}

export interface DeletionOutcome {
  readonly deferred: number;
  readonly deleted: readonly string[];
  readonly failed: readonly { readonly message: string; readonly worker: string }[];
}

/**
 * Deletes each release's Workers, the backend first; a release whose backend stays keeps its assets Worker too, so a
 * failure never leaves a release half present when it can be avoided. Each deletion is proven (see
 * {@link deleteImmutableWorker}); a failed one is reported and the others continue.
 */
export const deleteReleases = (releases: readonly PruneRelease[], settings: DeletionSettings) =>
  Effect.gen(function* deleteReleasesEffect() {
    const { accountId, token } = yield* provider;
    const pace = yield* deletionPacer(settings.requestsPerSecond);
    const started = yield* Clock.currentTimeMillis;
    const deleted: string[] = [];
    const failed: { message: string; worker: string }[] = [];
    let deferred = 0;
    const deleteRelease = (release: PruneRelease) =>
      Effect.gen(function* deleteReleaseEffect() {
        if ((yield* Clock.currentTimeMillis) - started >= Duration.toMillis(settings.timeBudget)) {
          deferred += 1;
          return;
        }
        for (const worker of release.workers) {
          yield* pace;
          const outcome = yield* Effect.result(deleteImmutableWorker(accountId, token, worker));
          if (Result.isFailure(outcome)) {
            failed.push({ message: outcome.failure.message, worker });
            yield* Effect.logError(`${worker} was not deleted: ${outcome.failure.message}`);
            return;
          }
          deleted.push(worker);
        }
      });
    yield* Effect.forEach(releases, deleteRelease, { concurrency: settings.concurrency, discard: true });
    return { deferred, deleted, failed } satisfies DeletionOutcome;
  });

const summarize = (plan: PrunePlan) => {
  const doomed = plan.releases.reduce((total, release) => total + release.workers.length, 0);
  const kept = KEEP_REASONS.map((reason) => `${reason} ${String(plan.kept[reason])}`).join(', ');
  return `${String(plan.accountWorkers)} account Workers, ${String(plan.immutableWorkers)} immutable; kept ${kept}; ${String(doomed)} unreferenced in ${String(plan.releases.length)} releases`;
};

const reportDeletion = (outcome: DeletionOutcome) =>
  Effect.gen(function* reportDeletionEffect() {
    yield* Effect.logInfo(
      `deleted ${String(outcome.deleted.length)} Workers; ${String(outcome.failed.length)} failed; ${String(outcome.deferred)} releases left for the next prune`,
    );
    if (outcome.failed.length > 0) {
      return yield* fail(
        `${String(outcome.failed.length)} immutable Workers could not be deleted: ${outcome.failed.map(({ worker }) => worker).join(', ')}`,
      )();
    }
    return yield* Effect.void;
  });

const keepFlags = {
  candidateFile: Flag.String('candidate-file').pipe(Flag.optional),
  graceMinutes: Flag.Int('grace-minutes').pipe(Flag.withDefault(Duration.toMinutes(PRUNE_GRACE))),
  ledgerFiles: Flag.String('ledger-file').pipe(Flag.atLeast(0)),
  trustedLedgers: Flag.Boolean('trusted-ledgers').pipe(Flag.withDefault(false)),
};
const deletionFlags = {
  concurrency: Flag.Int('concurrency').pipe(Flag.withDefault(4)),
  requestsPerSecond: Flag.Int('requests-per-second').pipe(Flag.withDefault(3)),
  timeBudgetSeconds: Flag.Int('time-budget-seconds').pipe(Flag.withDefault(900)),
};

const deletionSettings = (flags: {
  readonly concurrency: number;
  readonly requestsPerSecond: number;
  readonly timeBudgetSeconds: number;
}): DeletionSettings => ({
  concurrency: Math.max(1, flags.concurrency),
  requestsPerSecond: Math.max(1, flags.requestsPerSecond),
  timeBudget: Duration.seconds(Math.max(0, flags.timeBudgetSeconds)),
});

/** Lists the account, reads every keep source and plans the prune. */
const planAccountPrune = (flags: KeepOptions & { readonly graceMinutes: number }) =>
  Effect.gen(function* planAccountPruneEffect() {
    const workers = yield* listAccountWorkers;
    const keep = yield* readKeepSources(workers, flags);
    const plan = planImmutableWorkerPrune({
      grace: Duration.minutes(flags.graceMinutes),
      keep,
      now: yield* Clock.currentTimeMillis,
      workers,
    });
    yield* Effect.logInfo(summarize(plan));
    return plan;
  });

const pruneCommand = Command.make(
  'prune',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)), ...keepFlags, ...deletionFlags },
  (flags) =>
    Effect.gen(function* pruneImmutableWorkers() {
      const plan = yield* planAccountPrune(flags);
      if (!flags.apply) {
        for (const release of plan.releases) {
          yield* Effect.logInfo(`would delete ${release.workers.join(' ')}`);
        }
        return yield* Effect.logInfo('dry run: nothing was deleted (pass --apply to delete)');
      }
      return yield* reportDeletion(yield* deleteReleases(plan.releases, deletionSettings(flags)));
    }),
);

const PlannedUnitsSchema = Schema.Struct({
  units: Schema.Array(Schema.Struct({ mode: Schema.Literals(['build', 'retain', 'reupload']) })),
});

/** At most two new Workers for every unit the release uploads (the Shell needs one). */
export const plannedNewWorkers = (plan: typeof PlannedUnitsSchema.Type) =>
  2 * plan.units.filter(({ mode }) => mode !== 'retain').length;

const guardCommand = Command.make(
  'guard',
  {
    ceiling: Flag.Int('ceiling').pipe(Flag.withDefault(SAFE_WORKER_CEILING)),
    plan: Flag.String('plan'),
    ...keepFlags,
    ...deletionFlags,
  },
  (flags) =>
    Effect.gen(function* guardWorkerCapacity() {
      const fileSystem = yield* FileSystem.FileSystem;
      const planned = plannedNewWorkers(
        yield* fileSystem
          .readFileString(flags.plan)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PlannedUnitsSchema))),
            Effect.mapError(fail(`the deploy plan ${flags.plan} could not be read`)),
          ),
      );
      const before = (yield* listAccountWorkers).length;
      if (before + planned <= flags.ceiling) {
        return yield* Effect.logInfo(
          `${String(before)} account Workers and up to ${String(planned)} new ones stay within ${String(flags.ceiling)}`,
        );
      }
      const plan = yield* planAccountPrune(flags);
      const releases = oldestReleasesFreeing(plan.releases, before + planned - flags.ceiling);
      yield* reportDeletion(yield* deleteReleases(releases, deletionSettings(flags)));
      const after = (yield* listAccountWorkers).length;
      if (after + planned > flags.ceiling) {
        return yield* fail(
          `the account holds ${String(after)} Workers and this release needs up to ${String(planned)} more, above the safe ceiling of ${String(flags.ceiling)} (the provider stops at 500) even after pruning every unreferenced immutable release it could`,
        )();
      }
      return yield* Effect.logInfo(
        `pruned to ${String(after)} account Workers; up to ${String(planned)} new ones stay within ${String(flags.ceiling)}`,
      );
    }),
);

const command = Command.make('prune-immutable-workers').pipe(Command.withSubcommands([pruneCommand, guardCommand]));

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(
        Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'error' })).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
}
