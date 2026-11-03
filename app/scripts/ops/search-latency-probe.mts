#!/usr/bin/env node
/** Offline by default. `--run` requires an independently released P20 window and an admitted live corpus. */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';

import { ShellSearchPayloadSchema, ShellSearchResponseSchema } from '@app/shell-super-app/api';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Clock,
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Order,
  Redacted,
  Ref,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

export const SEARCH_ROUTE = '/shell-super-app-api/shell/search';
export const PROFILES = [1, 5] as const;
export const RUNS = 5;
export const SAMPLES_PER_RUN = 100;
export const SAMPLES_PER_PROFILE = RUNS * SAMPLES_PER_RUN;

const digest = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const releaseSha = Schema.String.check(Schema.isPattern(/^[a-f\d]{40}$/u));
const compositionRevision = Schema.String.check(Schema.isPattern(/^[a-f\d]{64}$/u));
const ADMITTED_LIVE = 'admitted-live' as const;
const OFFLINE_FIXTURE = 'offline-fixture' as const;
const tenantId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const legalEntityId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const requestId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('RequestId'));
const windowId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('WindowId'));
const nonempty = Schema.String.check(Schema.isMinLength(1));
const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const categories = ['selective', 'broad', 'exact', 'multiword', 'alias', 'temporal', 'empty-hit'] as const;
const resultKinds = ['http', 'transport', 'body', 'decode', 'schema', 'oracle', 'partial', 'cache', 'timeout'] as const;

const PinsSchema = Schema.Struct({
  compositionRevision,
  dataFingerprint: digest,
  grantProfile: nonempty,
  legalEntityId,
  networkPath: nonempty,
  principalProfile: nonempty,
  releaseSha,
  tenantId,
});
export const CorpusSchema = Schema.Struct({
  cases: Schema.Array(
    Schema.Struct({
      category: Schema.Literals(categories),
      expected: ShellSearchResponseSchema,
      id: nonempty,
      includeArchived: Schema.Boolean,
      lane: Schema.Literals(['comparison', 'expanded']),
      queries: Schema.Array(nonempty),
      role: Schema.optionalKey(Schema.Literals(['CUSTOMER', 'SUPPLIER'])),
    }),
  ),
  countsByResourceType: Schema.Record(Schema.String, count),
  mode: Schema.Literals([OFFLINE_FIXTURE, ADMITTED_LIVE]),
  origin: nonempty,
  pins: PinsSchema,
  provenance: nonempty,
  variantPolicy: Schema.Literal('case-and-whitespace'),
  version: Schema.Literal(1),
});
export type Corpus = typeof CorpusSchema.Type;
export type SearchCase = Corpus['cases'][number];

export const ApprovalSchema = Schema.Struct({
  approvedBy: Schema.Literal('root'),
  corpusSha256: digest,
  expiresAt: Schema.DateTimeUtcFromString,
  maxAttempts: count,
  notBefore: Schema.DateTimeUtcFromString,
  origin: nonempty,
  pins: PinsSchema,
  windowId,
});
export type Approval = typeof ApprovalSchema.Type;

class ProbeFailure extends Schema.TaggedError<ProbeFailure>()('ProbeFailure', {
  kind: Schema.optionalKey(Schema.Literals(resultKinds)),
  reason: Schema.optionalKey(Schema.String),
}) {}

/** Only metrics and admitted identity leave the process: never response bodies, request headers, or error causes. */
export interface Attempt {
  bytes: number;
  cache?: {
    readonly age: string | null;
    readonly cacheControl: string;
    readonly cfCacheStatus: string | null;
    readonly responseNoStore: boolean;
    readonly xCache: string | null;
  };
  caseId: string;
  correctnessChecked: boolean;
  fullBodyMs: number | null;
  headersMs: number | null;
  oracleMs: number | null;
  outcome: 'ok' | 'cancelled' | 'internal-error' | (typeof resultKinds)[number];
  partial: boolean | null;
  profile: number;
  querySha256: string;
  requestId: typeof requestId.Type;
  results: number | null;
  retry: 0;
  run: number;
  schemaMs: number | null;
  status: number | null;
  totalMs: number;
}

const WorkSchema = Schema.Struct({
  authorizationChecks: count,
  candidateCount: count,
  eligibleProviders: Schema.Array(nonempty),
  executedProviders: Schema.Array(nonempty),
  providerRetries: count,
  queryCacheHits: count,
  retrievals: count,
  rpcCalls: count,
  singleflightReuses: count,
  sqlCalls: count,
});

export const WorkEvidenceSchema = Schema.Struct({
  corpusSha256: digest,
  observations: Schema.Array(Schema.Struct({ requestId, work: WorkSchema })),
  pins: PinsSchema,
  source: nonempty,
});
export type WorkEvidence = typeof WorkEvidenceSchema.Type;

export const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Hashes the Schema-owned corpus encoding, not a hand-written canonical JSON serializer. The same
 * codec feeds the ready output, the approval check and the per-sample report.
 */
export const corpusHash = (corpus: Corpus) =>
  Effect.gen(function* encodeCorpusForHash() {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CorpusSchema))(corpus);
    return hash(encoded);
  });

const invalid = (reason: string) => Effect.fail(new ProbeFailure({ reason }));
const check = (condition: boolean, reason: string) => (condition ? Effect.void : invalid(reason));

const isLoopbackOrigin = (origin: URL) =>
  origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);

/** Balance the actual fixed schedule, not just categories hidden outside the request budget. */
export const buildSearchProbeSchedule = (corpus: Corpus) =>
  Effect.gen(function* scheduleAdmittedCases() {
    const buckets = categories.map((category) => corpus.cases.filter((item) => item.category === category));
    const schedule: SearchCase[] = [];
    for (let index = 0; index < SAMPLES_PER_PROFILE; index += 1) {
      const bucket = buckets[index % categories.length];
      const item = bucket?.[Math.floor(index / categories.length) % bucket.length];
      if (item === undefined) {
        return yield* invalid('Every measured category requires an admitted case.');
      }
      schedule.push(item);
    }
    const covered = new Set(schedule.map((item) => item.id));
    yield* check(
      corpus.cases.every((item) => covered.has(item.id)),
      'The balanced fixed request budget cannot exercise every admitted case; reduce or rebalance the corpus.',
    );
    return schedule;
  });

export const validateCorpus = (corpus: Corpus) =>
  Effect.gen(function* validateSearchCorpus() {
    const origin = URL.parse(corpus.origin);
    yield* check(
      origin !== null &&
        origin.origin === corpus.origin &&
        origin.username === '' &&
        origin.password === '' &&
        (origin.protocol === 'https:' || isLoopbackOrigin(origin)),
      'An exact HTTPS origin or loopback HTTP origin is required.',
    );
    yield* check(
      corpus.cases.length >= categories.length &&
        corpus.cases.length <= SAMPLES_PER_PROFILE &&
        new Set(corpus.cases.map((item) => item.id)).size === corpus.cases.length,
      'The fixed corpus requires unique case IDs and all seven categories.',
    );
    yield* check(
      corpus.cases.some((item) => item.lane === 'comparison') && corpus.cases.some((item) => item.lane === 'expanded'),
      'The fixed and expanded comparison lanes must both be present.',
    );
    for (const category of categories) {
      yield* check(
        corpus.cases.some((item) => item.category === category),
        `Missing corpus category: ${category}`,
      );
    }
    yield* check(
      Object.keys(corpus.countsByResourceType).length > 0 &&
        Object.values(corpus.countsByResourceType).some((value) => value > 0),
      'Record actual per-type corpus counts.',
    );
    for (const item of corpus.cases) {
      yield* check(
        item.queries.length > 0 && !item.expected.partial,
        'Every case needs admitted variants and a complete oracle.',
      );
      yield* check(
        item.category === 'empty-hit' ? item.expected.results.length === 0 : item.expected.results.length > 0,
        'Only the explicit empty-hit lane may have an empty oracle.',
      );
      for (const query of item.queries) {
        yield* check(
          query.length <= 160 && query.trim().length >= 2,
          'Admitted queries must leave space for fresh variants within the 200-character contract.',
        );
      }
      for (const result of item.expected.results) {
        yield* check(
          result.ref.tenantId === corpus.pins.tenantId,
          'Every expected reference must pin the selected tenant.',
        );
        yield* check(
          (corpus.countsByResourceType[result.ref.resourceType] ?? 0) > 0,
          'Every oracle resource type needs an actual count.',
        );
        if (result.kind === 'resource') {
          yield* check(
            result.selectedLegalEntityId === corpus.pins.legalEntityId,
            'Resource oracle has the wrong company.',
          );
        }
      }
    }
    yield* buildSearchProbeSchedule(corpus);
  });

const validateDispatchWindow = (approval: Approval, now: DateTime.Utc, attempts: number) =>
  Effect.gen(function* checkCurrentDispatchAuthority() {
    const start = DateTime.toEpochMillis(approval.notBefore);
    const end = DateTime.toEpochMillis(approval.expiresAt);
    const current = DateTime.toEpochMillis(now);
    yield* check(
      Number.isFinite(start) &&
        Number.isFinite(end) &&
        current >= start &&
        current < end &&
        end - start <= Duration.toMillis(Duration.hours(1)),
      'No current bounded measurement window.',
    );
    yield* check(
      attempts <= approval.maxAttempts && approval.maxAttempts <= SAMPLES_PER_PROFILE * PROFILES.length,
      'Window request budget exceeded; automatic replacement runs/retries are forbidden.',
    );
  });

export const validateWindow = (corpus: Corpus, approval: Approval, now: DateTime.Utc, attempts: number) =>
  Effect.gen(function* validateMeasurementWindow() {
    yield* validateCorpus(corpus);
    yield* check(
      corpus.mode === ADMITTED_LIVE,
      'P20 held: deterministic offline fixtures cannot be used against a live route.',
    );
    yield* check(
      approval.approvedBy === 'root' && approval.origin === corpus.origin,
      'The root window must name this exact origin.',
    );
    yield* check(
      approval.corpusSha256 === (yield* corpusHash(corpus)) && Equal.equals(approval.pins, corpus.pins),
      'The root window must pin this exact scope, release, data, grants and corpus.',
    );
    yield* validateDispatchWindow(approval, now, attempts);
  });

/** The set stores dispatched strings only, never answers. All attempts receive a new transport call and ID. */
export const freshQuery = (item: SearchCase, used: Set<string>) =>
  Effect.gen(function* makeFreshQuery() {
    for (let tries = 0; tries < 1000; tries += 1) {
      const base = item.queries[randomInt(item.queries.length)] ?? '';
      const text = base
        .trim()
        .split(/\s+/u)
        .map((word) =>
          Array.from(word, (letter) => (randomInt(2) === 0 ? letter.toLowerCase() : letter.toUpperCase())).join(''),
        )
        .join(' '.repeat(randomInt(1, 5)));
      const query = `${' '.repeat(randomInt(0, 20))}${text}${' '.repeat(randomInt(0, 20))}`;
      if (query.length <= 200 && !used.has(query)) {
        used.add(query);
        return query;
      }
    }
    return yield* invalid('The admitted variant space is exhausted; do not reuse an answer or change query semantics.');
  });

const attemptFailure = (kind: (typeof resultKinds)[number]) => new ProbeFailure({ kind });

/** Clock starts immediately before dispatch; full-body, schema and exact safe oracle checks are all inside totalMs. */
export const probeAttempt = (options: {
  readonly cookie: Redacted.Redacted;
  readonly corpus: Corpus;
  readonly item: SearchCase;
  readonly profile: number;
  readonly query: string;
  readonly record: (sample: Attempt) => void;
  readonly run: number;
  readonly timeoutMs: number;
}) =>
  Effect.gen(function* measureCompleteAuthenticatedRequest() {
    const client = yield* HttpClient.HttpClient;
    const payloadFields = {
      compositionRevision: options.corpus.pins.compositionRevision,
      includeArchived: options.item.includeArchived,
      query: options.query,
    };
    const payload =
      options.item.role === undefined
        ? yield* Schema.decodeUnknownEffect(ShellSearchPayloadSchema)(payloadFields)
        : yield* Schema.decodeUnknownEffect(ShellSearchPayloadSchema)({ ...payloadFields, role: options.item.role });
    const attemptId = yield* Schema.decodeUnknownEffect(requestId)(randomUUID());
    const request = HttpClientRequest.post(`${options.corpus.origin}${SEARCH_ROUTE}`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        ...payload,
      }),
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        'cache-control': 'no-store',
        cookie: Redacted.value(options.cookie),
        origin: options.corpus.origin,
        pragma: 'no-cache',
        'x-correlation-id': attemptId,
        'x-search-probe-request-id': attemptId,
      }),
    );
    const sample: Attempt = {
      bytes: 0,
      caseId: options.item.id,
      correctnessChecked: false,
      fullBodyMs: null,
      headersMs: null,
      oracleMs: null,
      outcome: 'internal-error',
      partial: null,
      profile: options.profile,
      querySha256: hash(options.query),
      requestId: attemptId,
      results: null,
      retry: 0,
      run: options.run,
      schemaMs: null,
      status: null,
      totalMs: 0,
    };
    const started = yield* Clock.currentTimeNanos;
    const elapsed = Clock.currentTimeNanos.pipe(Effect.map((now) => Number(now - started) / 1_000_000));
    const work = Effect.gen(function* receiveAndCheckBody() {
      const response = yield* client.execute(request).pipe(Effect.mapError(() => attemptFailure('transport')));
      sample.status = response.status;
      sample.headersMs = yield* elapsed;
      const buffer = yield* response.arrayBuffer.pipe(Effect.mapError(() => attemptFailure('body')));
      sample.bytes = buffer.byteLength;
      sample.fullBodyMs = yield* elapsed;
      if (response.status !== 200) {
        return yield* attemptFailure('http');
      }
      const text = yield* Effect.try({
        catch: () => attemptFailure('decode'),
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(buffer),
      });
      const raw = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError(() => attemptFailure('decode')),
      );
      const body = yield* Schema.decodeUnknownEffect(ShellSearchResponseSchema, { onExcessProperty: 'error' })(
        raw,
      ).pipe(Effect.mapError(() => attemptFailure('schema')));
      sample.schemaMs = yield* elapsed;
      sample.results = body.results.length;
      sample.partial = body.partial;
      if (body.partial) {
        return yield* attemptFailure('partial');
      }
      if (!Equal.equals(body, options.item.expected)) {
        return yield* attemptFailure('oracle');
      }
      sample.correctnessChecked = true;
      sample.oracleMs = yield* elapsed;
      const {
        age,
        'cache-control': cacheControl = '',
        'cf-cache-status': cfCacheStatus,
        'x-cache': fallbackCacheStatus,
      } = response.headers;
      sample.cache = {
        age: age ?? null,
        cacheControl,
        cfCacheStatus: cfCacheStatus ?? null,
        responseNoStore: /(?:^|,)\s*no-store\s*(?:,|$)/iu.test(cacheControl),
        xCache: fallbackCacheStatus ?? null,
      };
      // Missing no-store is unknown provenance, not evidence that a response was reused.
      // Check every cache layer independently; DYNAMIC must never conceal another layer's HIT.
      if (
        (age !== undefined && /^\d+$/u.test(age) && Number(age) > 0) ||
        [cfCacheStatus, fallbackCacheStatus].some((status) => /\b(?:HIT|STALE|REVALIDATED)\b/iu.test(status ?? ''))
      ) {
        return yield* attemptFailure('cache');
      }
      sample.outcome = 'ok';
      return yield* Effect.void;
    }).pipe(
      Effect.timeout(Duration.millis(options.timeoutMs)),
      Effect.catchTag('ProbeFailure', (failure) =>
        Effect.sync(() => {
          sample.outcome = failure.kind ?? 'internal-error';
        }),
      ),
      Effect.catchTag('TimeoutError', () =>
        Effect.sync(() => {
          sample.outcome = 'timeout';
        }),
      ),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          sample.outcome = 'cancelled';
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* preserveEveryAttempt() {
          sample.totalMs = yield* elapsed;
          options.record(sample);
        }),
      ),
    );
    yield* work;
    return sample;
  });

const percentile = (values: readonly number[], quantile: number) => {
  const sorted = EffectArray.sort(values, Order.Number);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
};

const isCorrect = (sample: Attempt) => sample.outcome === 'ok' && sample.correctnessChecked;
const countMatching = (samples: readonly Attempt[], predicate: (sample: Attempt) => boolean) =>
  samples.filter(predicate).length;
const matchesOutcome = (outcome: Attempt['outcome']) => (sample: Attempt) => sample.outcome === outcome;
const nextDispatch = (counter: Ref.Ref<number>) => Ref.updateAndGet(counter, (value) => value + 1);
const sumBy = (samples: readonly Attempt[], select: (sample: Attempt) => number) =>
  samples.reduce((total, sample) => total + select(sample), 0);
const roundsFor = (attempts: readonly Attempt[]) =>
  Array.from({ length: RUNS }, (_, index) => {
    const round = attempts.filter((sample) => sample.run === index + 1);
    return {
      attempts: round.length,
      correct: countMatching(round, isCorrect),
      run: index + 1,
    };
  });
const countsFor = (attempts: readonly Attempt[]) =>
  Object.fromEntries(
    [...new Set(attempts.map((sample) => sample.outcome))].map((outcome) => [
      outcome,
      countMatching(attempts, matchesOutcome(outcome)),
    ]),
  );
const statusCountsFor = (attempts: readonly Attempt[]) =>
  Object.fromEntries(
    [...new Set(attempts.map((sample) => String(sample.status)))].map((status) => [
      status,
      attempts.filter((sample) => String(sample.status) === status).length,
    ]),
  );

export const summarize = (samples: readonly Attempt[], corpus: Corpus, evidence: WorkEvidence | null = null) =>
  Effect.gen(function* summarizeAttempts() {
    const corpusSha = yield* corpusHash(corpus);
    const evidencePinned =
      evidence !== null && evidence.corpusSha256 === corpusSha && Equal.equals(evidence.pins, corpus.pins);
    const observed = new Map<string, typeof WorkSchema.Type>();
    const duplicates = new Set<string>();
    for (const observation of evidence?.observations ?? []) {
      if (observed.has(observation.requestId)) {
        duplicates.add(observation.requestId);
      }
      observed.set(observation.requestId, observation.work);
    }
    const workVerified = (sample: Attempt) => {
      const work = observed.get(sample.requestId);
      return (
        evidencePinned &&
        !duplicates.has(sample.requestId) &&
        work !== undefined &&
        work.retrievals > 0 &&
        work.authorizationChecks > 0 &&
        work.sqlCalls > 0 &&
        work.queryCacheHits === 0 &&
        work.singleflightReuses === 0 &&
        work.eligibleProviders.length > 0 &&
        Equal.equals(
          EffectArray.sort([...new Set(work.executedProviders)], Order.String),
          EffectArray.sort([...new Set(work.eligibleProviders)], Order.String),
        )
      );
    };
    const profiles = PROFILES.map((profile) => {
      const attempts = samples.filter((sample) => sample.profile === profile);
      const correct = attempts.filter(isCorrect);
      const timings = correct.map((sample) => sample.totalMs);
      const rounds = roundsFor(attempts);
      const p95 = percentile(timings, 0.95);
      const measurementComplete =
        attempts.length === SAMPLES_PER_PROFILE &&
        correct.length === SAMPLES_PER_PROFILE &&
        rounds.every((round) => round.attempts === SAMPLES_PER_RUN && round.correct === SAMPLES_PER_RUN);
      const latencyTargetMet = measurementComplete && p95 !== null && p95 < 200;
      const gate = latencyTargetMet && attempts.every(workVerified);
      return {
        attempts: attempts.length,
        bytes: sumBy(attempts, (sample) => sample.bytes),
        cacheNoStoreHeaders: countMatching(attempts, (sample) => sample.cache?.responseNoStore === true),
        concurrency: profile,
        correct: correct.length,
        counts: countsFor(attempts),
        errors: attempts.length - correct.length,
        gate,
        latencyTargetMet,
        maxMs: timings.length === 0 ? null : Math.max(...timings),
        measurementComplete,
        oracleChecked: correct.length,
        p50Ms: percentile(timings, 0.5),
        p95Ms: p95,
        p99Ms: percentile(timings, 0.99),
        partial: countMatching(attempts, (sample) => sample.partial === true),
        providerRetries: evidencePinned
          ? sumBy(attempts, (sample) => observed.get(sample.requestId)?.providerRetries ?? 0)
          : null,
        results: sumBy(attempts, (sample) => sample.results ?? 0),
        retries: 0,
        revision: corpus.pins.compositionRevision,
        rounds,
        statusCounts: statusCountsFor(attempts),
        workVerified: countMatching(attempts, workVerified),
      };
    });
    return {
      corpusSha256: corpusSha,
      countsByResourceType: corpus.countsByResourceType,
      endpoint: `${corpus.origin}${SEARCH_ROUTE}`,
      gate: corpus.mode === ADMITTED_LIVE && profiles.every((profile) => profile.gate),
      latencyTargetMet: corpus.mode === ADMITTED_LIVE && profiles.every((profile) => profile.latencyTargetMet),
      liveMeasurement: corpus.mode === ADMITTED_LIVE && samples.length > 0,
      measurement: 'dispatch through full body, schema decode and exact oracle; no debounce or browser paint claim',
      measurementComplete: profiles.every((profile) => profile.measurementComplete),
      mode: corpus.mode,
      pins: corpus.pins,
      profiles,
      samples,
      uncachedWorkVerification: evidencePinned
        ? 'external-correlated-counters-require-independent-source-review'
        : 'unknown',
      workEvidence: evidencePinned && evidence !== null ? { source: evidence.source } : null,
    };
  });

/** Five bounded interleaved C1/C5 rounds; fixed attempt budget, no warmup, no automatic retries or answer reuse. */
export const runProbe = (
  corpus: Corpus,
  approval: Approval,
  cookie: Redacted.Redacted,
  record: (sample: Attempt) => void,
) =>
  Effect.gen(function* runBoundedProfiles() {
    yield* validateWindow(corpus, approval, DateTime.makeUnsafe(yield* Clock.currentTimeMillis), 0);
    const schedule = yield* buildSearchProbeSchedule(corpus);
    const used = new Set<string>();
    const dispatchedRef = yield* Ref.make(0);
    for (let run = 1; run <= RUNS; run += 1) {
      for (const profile of PROFILES) {
        const currentRun = run;
        const currentProfile = profile;
        yield* Effect.forEach(
          Array.from({ length: SAMPLES_PER_RUN }, (_, index) => index),
          (index) =>
            Effect.gen(function* runOneSample() {
              const dispatched = yield* nextDispatch(dispatchedRef);
              // Full immutable corpus/scope identity was checked before the run, not between timed peers.
              yield* validateDispatchWindow(approval, DateTime.makeUnsafe(yield* Clock.currentTimeMillis), dispatched);
              const item = schedule[(currentRun - 1) * SAMPLES_PER_RUN + index];
              if (item === undefined) {
                return yield* invalid('No admitted query.');
              }
              const query = yield* freshQuery(item, used);
              return yield* probeAttempt({
                cookie,
                corpus,
                item,
                profile: currentProfile,
                query,
                record,
                run: currentRun,
                timeoutMs: 10_000,
              });
            }),
          { concurrency: currentProfile, discard: true },
        );
      }
    }
  });

const readJson = (file: string) =>
  Effect.gen(function* readPublicProbeInput() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => new ProbeFailure({ reason: 'Unable to read the public probe input file.' })));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError(() => new ProbeFailure({ reason: 'Unable to decode the public probe input file.' })),
    );
  });

const loadCorpus = (file: string) =>
  readJson(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CorpusSchema)),
    Effect.mapError(() => new ProbeFailure({ reason: 'Corpus does not match the probe schema.' })),
  );

const probe = (ready: boolean, run: boolean) =>
  Effect.gen(function* searchProbeCli() {
    yield* check(ready !== run, 'Usage: search-latency-probe --ready|--run');
    const corpusPath = yield* Config.String('SEARCH_PROBE_CORPUS').pipe(
      Config.withDefault(new URL('search-latency-corpus.json', import.meta.url).pathname),
    );
    const corpus = yield* loadCorpus(corpusPath);
    yield* validateCorpus(corpus);
    if (ready) {
      const readyReport = {
        corpusSha256: yield* corpusHash(corpus),
        liveCalls: 0,
        measurement: 'not-run',
        mode: corpus.mode,
        p20: 'HELD',
        profiles: PROFILES,
        ready: true,
        requiredLiveInputs: [
          'admitted-live corpus',
          'root approval window',
          'SEARCH_PROBE_COOKIE via injected environment',
          'OWNED_TEMP_DIR',
        ],
        runs: RUNS,
        samplesPerProfile: SAMPLES_PER_PROFILE,
        uncachedProofNeeds: ['genuine request-correlated backend work/cache evidence, independently verified'],
      };
      return yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(readyReport));
    }
    const approvalPath = yield* Config.String('SEARCH_PROBE_APPROVAL');
    const approval = yield* readJson(approvalPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ApprovalSchema)),
      Effect.mapError(() => new ProbeFailure({ reason: 'A root approval document is required.' })),
    );
    // Validate P20 before even resolving credentials. This command never creates or acquires a session.
    yield* validateWindow(corpus, approval, DateTime.makeUnsafe(yield* Clock.currentTimeMillis), 0);
    const cookie = yield* Config.Redacted('SEARCH_PROBE_COOKIE');
    yield* check(
      Redacted.value(cookie).length > 0 && !/[\r\n]/u.test(Redacted.value(cookie)),
      'An injected session cookie is required.',
    );
    const output = yield* Config.String('OWNED_TEMP_DIR');
    yield* check(path.isAbsolute(output), 'Run through owned-temp-dir; an absolute OWNED_TEMP_DIR is required.');
    const fs = yield* FileSystem.FileSystem;
    const samples: Attempt[] = [];
    const reportRef = yield* Ref.make<{
      readonly gate: boolean;
      readonly latencyTargetMet: boolean;
      readonly measurementComplete: boolean;
    } | null>(null);
    const writeReport = Effect.gen(function* preservePartialProbeReport() {
      // An externally captured, request-ID-correlated work receipt may become available during the run.
      const evidencePath = yield* Config.String('SEARCH_PROBE_WORK_EVIDENCE').pipe(Config.withDefault(''));
      const evidence =
        evidencePath === ''
          ? null
          : yield* readJson(evidencePath).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(WorkEvidenceSchema)),
              Effect.orElseSucceed(() => null),
            );
      const summary = yield* summarize(samples, corpus, evidence);
      yield* Ref.set(reportRef, summary);
      const reportPath = path.join(output, 'search-latency-report.json');
      yield* fs.writeFileString(
        reportPath,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(summary),
        {
          mode: 0o600,
        },
      );
      yield* Console.log(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          attempts: samples.length,
          gate: summary.gate,
          output: reportPath,
        }),
      );
    });
    yield* runProbe(corpus, approval, cookie, (sample) => {
      samples.push(sample);
    }).pipe(Effect.ensuring(writeReport.pipe(Effect.orDie)));
    const report = yield* Ref.get(reportRef);
    if (report === null) {
      return yield* invalid('No probe report was produced.');
    }
    if (!report.measurementComplete) {
      return yield* invalid('Incomplete or incorrect measurement; every attempted response remains in the report.');
    }
    if (!report.latencyTargetMet) {
      return yield* invalid('Measurement completed, but the observed full-body latency target was not met.');
    }
    if (!report.gate) {
      yield* Console.log(
        'Latency/correctness measured; uncached-work verification remains unknown. This is not an uncached SLO PASS.',
      );
    }
    return yield* Effect.void;
  });

const command = Command.make(
  'search-latency-probe',
  {
    ready: Flag.Boolean('ready').pipe(Flag.withDefault(false)),
    run: Flag.Boolean('run').pipe(Flag.withDefault(false)),
  },
  ({ ready, run }) => probe(ready, run),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.tapCause(() =>
        Console.error(
          'Search probe failed or interrupted; P20/scope/correctness/work gates remain unverified. No secrets or response bodies are logged.',
        ),
      ),
      Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
    { disableErrorReporting: true },
  );
}
