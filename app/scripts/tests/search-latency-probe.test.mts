import { ShellSearchPayloadSchema, ShellSearchResponseSchema } from '@app/shell-super-app/api';
import { Clock, DateTime, Duration, Effect, Exit, Fiber, Match, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http/HttpClientRequest';
import { expect, it } from 'effect-rstest';

import fixture from '../ops/search-latency-corpus.json' with { type: 'json' };
import {
  ApprovalSchema,
  CorpusSchema,
  SEARCH_ROUTE,
  buildSearchProbeSchedule,
  corpusHash,
  freshQuery,
  probeAttempt,
  runProbe,
  summarize,
  validateCorpus,
  validateWindow,
} from '../ops/search-latency-probe.mts';
import type { Attempt, Corpus, SearchCase, WorkEvidence } from '../ops/search-latency-probe.mts';

const corpus = Schema.decodeUnknownSync(CorpusSchema)(fixture);
const liveCorpus: Corpus = { ...corpus, mode: 'admitted-live' };
const cookie = Redacted.make('opaque-cookie=DO-NOT-LOG-THIS');
const secret = 'DO-NOT-LOG-THIS';
const jsonHeaders = { 'cache-control': 'private, no-store', 'content-type': 'application/json' };
const requestIdHeader = 'x-search-probe-request-id';

const requireFirst = <T,>(values: readonly T[]): Effect.Effect<T> => {
  const [first] = values;
  return first === undefined ? Effect.die('A required scripted fixture value is missing.') : Effect.succeed(first);
};

const approvalFor = (value: Corpus) =>
  Effect.gen(function* makeApproval() {
    const now = yield* Clock.currentTimeMillis;
    return yield* Schema.decodeUnknownEffect(ApprovalSchema)({
      approvedBy: 'root',
      corpusSha256: yield* corpusHash(value),
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
      maxAttempts: 1000,
      notBefore: DateTime.formatIso(DateTime.makeUnsafe(now - 1000)),
      origin: value.origin,
      pins: value.pins,
      windowId: 'offline-test-only',
    });
  });

const requestBody = (request: HttpClientRequest) => {
  const text = Match.value(request.body).pipe(
    Match.tag('Uint8Array', (body) => new TextDecoder().decode(body.body)),
    Match.orElse(() => ''),
  );
  return Schema.decodeUnknownEffect(Schema.fromJsonString(ShellSearchPayloadSchema))(text).pipe(Effect.orDie);
};

const scriptedResponse = (status: number, body: string, headers: Record<string, string> = jsonHeaders) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { headers, status }))),
  );

const jsonResponse = (
  body: typeof ShellSearchResponseSchema.Type,
  status = 200,
  headers: Record<string, string> = jsonHeaders,
) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { headers, status }))),
  );

const withArrayBuffer = (
  response: HttpClientResponse.HttpClientResponse,
  arrayBuffer: Effect.Effect<ArrayBuffer, HttpClientError.HttpClientError>,
): HttpClientResponse.HttpClientResponse => {
  Object.defineProperty(response, 'arrayBuffer', { value: arrayBuffer });
  return response;
};

const bodyText = <T,>(value: T) => Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
const normalizedQuery = (text: string) =>
  text.trim().toLowerCase().normalize('NFD').replaceAll(/\p{M}/gu, '').replaceAll(/\s+/gu, ' ');
const findScriptedCase = (query: string) =>
  corpus.cases.find((entry) =>
    entry.queries.some((candidate) => normalizedQuery(candidate) === normalizedQuery(query)),
  );

const measure = (client: HttpClient.HttpClient, sampleCase: SearchCase, timeoutMs = 1000) =>
  Effect.gen(function* measureOneRequest() {
    const samples: Attempt[] = [];
    const query = yield* requireFirst(sampleCase.queries);
    const sample = yield* probeAttempt({
      cookie,
      corpus,
      item: sampleCase,
      profile: 1,
      query,
      record: (entry) => {
        samples.push(entry);
      },
      run: 1,
      timeoutMs,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(samples).toEqual([sample]);
    return sample;
  });

it.effect('offline corpus is honest, complete, scoped and never a fake empty benchmark', () =>
  Effect.gen(function* validateDeterministicFixtures() {
    yield* validateCorpus(corpus);
    expect(corpus.mode).toBe('offline-fixture');
    expect(corpus.cases.filter((entry) => entry.expected.results.length === 0).map((entry) => entry.category)).toEqual([
      'empty-hit',
    ]);
    const invalid = {
      ...corpus,
      cases: corpus.cases.map((entry) => ({ ...entry, expected: { partial: false, results: [] } })),
    };
    expect(Exit.isFailure(yield* Effect.exit(validateCorpus(invalid)))).toBe(true);
  }),
);

it.effect('P20 rejects offline fixtures, unpinned, future, expired and excessive windows before transport', () =>
  Effect.gen(function* windowNegativeControls() {
    const approval = yield* approvalFor(liveCorpus);
    const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
    const offlineApproval = yield* approvalFor(corpus);
    for (const [target, grant, instant] of [
      [corpus, offlineApproval, now],
      [liveCorpus, { ...approval, corpusSha256: 'f'.repeat(64) }, now],
      [liveCorpus, { ...approval, origin: 'https://other.invalid' }, now],
      [liveCorpus, { ...approval, pins: { ...approval.pins, grantProfile: 'other-grants' } }, now],
      [liveCorpus, approval, DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 120_000)],
      [liveCorpus, approval, DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 120_000)],
      [liveCorpus, { ...approval, maxAttempts: 1001 }, now],
    ] as const) {
      expect(Exit.isFailure(yield* Effect.exit(validateWindow(target, grant, instant, 1000)))).toBe(true);
    }
    expect(Exit.isSuccess(yield* Effect.exit(validateWindow(liveCorpus, approval, now, 1000)))).toBe(true);
    let calls = 0;
    const noNetwork = HttpClient.make(() => {
      calls += 1;
      return Effect.die('P20 must block before this seam');
    });
    yield* Effect.exit(
      runProbe(corpus, offlineApproval, cookie, () => {
        // P20 must fail before the transport seam, so no sample can be recorded.
      }).pipe(Effect.provideService(HttpClient.HttpClient, noNetwork)),
    );
    expect(calls).toBe(0);
  }),
);

it.live('actual POST uses full public payload, fresh request ID, no-store and injected secret, never logs it', () =>
  Effect.gen(function* inspectRealRequestConstruction() {
    const item = yield* requireFirst(corpus.cases);
    const calls: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.gen(function* inspectRequest() {
        expect(request.method).toBe('POST');
        expect(request.url).toBe(`${corpus.origin}${SEARCH_ROUTE}`);
        expect(request.headers.cookie).toBe(Redacted.value(cookie));
        expect(request.headers.origin).toBe(corpus.origin);
        expect(request.headers['cache-control']).toBe('no-store');
        expect(request.headers.pragma).toBe('no-cache');
        expect(request.headers['x-correlation-id']).toBe(request.headers[requestIdHeader]);
        const payload = yield* requestBody(request);
        expect(payload.query).toBe(yield* requireFirst(item.queries));
        expect(payload.includeArchived).toBe(false);
        expect(payload.compositionRevision).toBe(corpus.pins.compositionRevision);
        expect(payload.role).toBeUndefined();
        calls.push(request.headers[requestIdHeader] ?? '');
        return HttpClientResponse.fromWeb(request, Response.json(item.expected, { headers: jsonHeaders }));
      }),
    );
    const first = yield* measure(http, item);
    const second = yield* measure(http, item);
    expect(calls.length).toBe(2);
    expect(new Set(calls).size).toBe(2);
    expect(first.outcome).toBe('ok');
    expect(first.correctnessChecked).toBe(true);
    expect(first.bytes).toBe(new TextEncoder().encode(yield* bodyText(item.expected)).length);
    expect(first.results).toBe(1);
    expect(first.oracleMs).not.toBeNull();
    if (first.oracleMs !== null) {
      expect(first.totalMs).toBeGreaterThanOrEqual(first.oracleMs);
    }
    const rendered = yield* bodyText([first, second]);
    expect(rendered).not.toContain(secret);
    const title = yield* requireFirst(item.expected.results);
    expect(rendered).not.toContain(title.title);
  }),
);

for (const status of [401, 403, 503]) {
  it.live(`HTTP ${status} retains complete body bytes/status but never becomes a fast success or retries`, () =>
    Effect.gen(function* countHttpFailure() {
      const item = yield* requireFirst(corpus.cases);
      const sample = yield* measure(scriptedResponse(status, `{"detail":"${secret}"}`), item);
      expect(sample.status).toBe(status);
      expect(sample.outcome).toBe('http');
      expect(sample.bytes).toBeGreaterThan(0);
      expect(sample.fullBodyMs).not.toBeNull();
      expect(sample.correctnessChecked).toBe(false);
      expect(sample.retry).toBe(0);
      expect(yield* bodyText(sample)).not.toContain(secret);
    }),
  );
}

it.live('transport failure is typed/sanitized, recorded exactly once and not retried', () =>
  Effect.gen(function* recordTransportError() {
    const item = yield* requireFirst(corpus.cases);
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls += 1;
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ cause: secret, request }),
        }),
      );
    });
    const sample = yield* measure(http, item);
    expect(sample.outcome).toBe('transport');
    expect(sample.status).toBeNull();
    expect(calls).toBe(1);
    expect(yield* bodyText(sample)).not.toContain(secret);
  }),
);

it.live('invalid JSON and invalid success schema remain distinct failures', () =>
  Effect.gen(function* rejectMalformedResponses() {
    const item = yield* requireFirst(corpus.cases);
    expect((yield* measure(scriptedResponse(200, '{broken'), item)).outcome).toBe('decode');
    expect((yield* measure(scriptedResponse(200, '{"results":[]}'), item)).outcome).toBe('schema');
    expect(
      (yield* measure(
        scriptedResponse(200, '{"partial":false,"results":[{"kind":"resource","title":"Missing typed ref"}]}'),
        item,
      )).outcome,
    ).toBe('schema');
  }),
);

it.live('full body read failure is distinct from transport/header success and never logs the body', () =>
  Effect.gen(function* rejectBodyReadFailure() {
    const item = yield* requireFirst(corpus.cases);
    const http = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, Response.json(item.expected, { headers: jsonHeaders }));
      return Effect.succeed(
        withArrayBuffer(
          response,
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.DecodeError({ cause: secret, request, response }),
            }),
          ),
        ),
      );
    });
    const sample = yield* measure(http, item);
    expect(sample.outcome).toBe('body');
    expect(sample.status).toBe(200);
    expect(sample.fullBodyMs).toBeNull();
    expect(yield* bodyText(sample)).not.toContain(secret);
  }),
);

it.live('delayed body is included before schema/oracle completion, not just time-to-headers', () =>
  Effect.gen(function* measureDelayedBody() {
    const item = yield* requireFirst(corpus.cases);
    const http = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, Response.json(item.expected, { headers: jsonHeaders }));
      return Effect.succeed(
        withArrayBuffer(response, Effect.sleep(Duration.millis(40)).pipe(Effect.andThen(response.arrayBuffer))),
      );
    });
    const sample = yield* measure(http, item);
    expect(sample.outcome).toBe('ok');
    expect(sample.headersMs).not.toBeNull();
    expect(sample.fullBodyMs).not.toBeNull();
    expect(sample.schemaMs).not.toBeNull();
    expect(sample.oracleMs).not.toBeNull();
    if (
      sample.headersMs !== null &&
      sample.fullBodyMs !== null &&
      sample.schemaMs !== null &&
      sample.oracleMs !== null
    ) {
      expect(sample.fullBodyMs - sample.headersMs).toBeGreaterThanOrEqual(30);
      expect(sample.schemaMs).toBeGreaterThanOrEqual(sample.fullBodyMs);
      expect(sample.oracleMs).toBeGreaterThanOrEqual(sample.schemaMs);
      expect(sample.totalMs).toBeGreaterThanOrEqual(sample.oracleMs);
    }
  }),
);

it.live('a delayed body times out and preserves the attempt instead of counting header success', () =>
  Effect.gen(function* timeoutDelayedBody() {
    const item = yield* requireFirst(corpus.cases);
    const http = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, Response.json(item.expected, { headers: jsonHeaders }));
      return Effect.succeed(withArrayBuffer(response, Effect.never));
    });
    const sample = yield* measure(http, item, 15);
    expect(sample.outcome).toBe('timeout');
    expect(sample.status).toBe(200);
    expect(sample.correctnessChecked).toBe(false);
  }),
);

it.live('partial, empty placeholder, wrong title, extra hidden fields and wrong ranking never pass the oracle', () =>
  Effect.gen(function* oracleNegativeControls() {
    const item = yield* requireFirst(corpus.cases);
    const firstResult = yield* requireFirst(item.expected.results);
    if (firstResult.kind !== 'resource') {
      return yield* Effect.die('The first fixture result must be a resource.');
    }
    const { expected } = item;
    expect((yield* measure(jsonResponse({ ...expected, partial: true }), item)).outcome).toBe('partial');
    expect((yield* measure(jsonResponse({ partial: false, results: [] }), item)).outcome).toBe('oracle');
    expect(
      (yield* measure(jsonResponse({ partial: false, results: [{ ...firstResult, title: 'Wrong record' }] }), item))
        .outcome,
    ).toBe('oracle');
    const hidden = yield* bodyText({ ...expected, privateContact: secret });
    expect((yield* measure(scriptedResponse(200, hidden), item)).outcome).toBe('schema');
    const otherResult = yield* Schema.decodeUnknownEffect(ShellSearchResponseSchema)({
      partial: false,
      results: [
        {
          kind: 'resource',
          ref: { ...firstResult.ref, resourceId: '44444444-4444-4444-8444-444444444444' },
          selectedLegalEntityId: corpus.pins.legalEntityId,
          title: 'Second approved record',
        },
      ],
    });
    const other = yield* requireFirst(otherResult.results);
    const ranked: SearchCase = { ...item, expected: { partial: false, results: [firstResult, other] } };
    expect((yield* measure(jsonResponse({ partial: false, results: [other, firstResult] }), ranked)).outcome).toBe(
      'oracle',
    );
    expect(yield* bodyText(other)).not.toContain(secret);
    return yield* Effect.void;
  }),
);

it.live('legitimate empty-hit is correctness-checked but cannot replace nonempty corpus cases', () =>
  Effect.gen(function* verifyHonestEmpty() {
    const empty = yield* requireFirst(corpus.cases.filter((entry) => entry.category === 'empty-hit'));
    const sample = yield* measure(jsonResponse(empty.expected), empty);
    expect(sample.outcome).toBe('ok');
    expect(sample.results).toBe(0);
    expect(sample.correctnessChecked).toBe(true);
  }),
);

it.live('unknown cache provenance preserves measurement, while every observed cache hit fails', () =>
  Effect.gen(function* cacheNegativeControls() {
    const item = yield* requireFirst(corpus.cases);
    const unknown = yield* measure(jsonResponse(item.expected, 200, { 'content-type': 'application/json' }), item);
    expect(unknown.outcome).toBe('ok');
    expect(unknown.cache?.responseNoStore).toBe(false);
    expect(
      (yield* measure(
        jsonResponse(item.expected, 200, {
          ...jsonHeaders,
          'cf-cache-status': 'DYNAMIC',
          'x-cache': 'HIT',
        }),
        item,
      )).outcome,
    ).toBe('cache');
    expect((yield* measure(jsonResponse(item.expected, 200, { ...jsonHeaders, age: '1' }), item)).outcome).toBe(
      'cache',
    );
    expect(
      (yield* measure(jsonResponse(item.expected, 200, { ...jsonHeaders, 'cf-cache-status': 'HIT' }), item)).outcome,
    ).toBe('cache');
    expect((yield* measure(jsonResponse(item.expected, 200, { ...jsonHeaders, 'x-cache': 'HIT' }), item)).outcome).toBe(
      'cache',
    );
  }),
);

it.live('cancellation interrupts in-flight body work and records exactly one cancelled attempt', () =>
  Effect.gen(function* cancelPendingBody() {
    const item = yield* requireFirst(corpus.cases);
    const samples: Attempt[] = [];
    let bodyStarted = false;
    let bodyInterrupted = false;
    const http = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, Response.json(item.expected, { headers: jsonHeaders }));
      const body = Effect.sync(() => {
        bodyStarted = true;
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            bodyInterrupted = true;
          }),
        ),
      );
      return Effect.succeed(withArrayBuffer(response, body));
    });
    const query = yield* requireFirst(item.queries);
    const fiber = yield* probeAttempt({
      cookie,
      corpus,
      item,
      profile: 1,
      query,
      record: (sample) => {
        samples.push(sample);
      },
      run: 1,
      timeoutMs: 1000,
    }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.forkChild);
    yield* Effect.sleep(Duration.millis(15));
    yield* Fiber.interrupt(fiber);
    expect(bodyStarted).toBe(true);
    expect(bodyInterrupted).toBe(true);
    expect(samples.length).toBe(1);
    const [sample] = samples;
    expect(sample?.outcome).toBe('cancelled');
    expect(sample?.correctnessChecked).toBe(false);
  }),
);

it.effect('fresh semantic variants have no answer store and stay inside the shared query limit', () =>
  Effect.gen(function* generateUncachedVariants() {
    const item = yield* requireFirst(corpus.cases);
    const used = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const query = yield* freshQuery(item, used);
      expect(query.length).toBeLessThanOrEqual(200);
      expect(item.queries.map((value) => value.toLowerCase()).includes(query.trim().toLowerCase())).toBe(true);
    }
    expect(used.size).toBe(100);
  }),
);

it.live('invalid UTF-8 is a classified decode failure, not an unhandled defect', () =>
  Effect.gen(function* invalidUtf8() {
    const item = yield* requireFirst(corpus.cases);
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(new Uint8Array([0xff]), { headers: jsonHeaders })),
      ),
    );
    expect((yield* measure(client, item)).outcome).toBe('decode');
    expect((yield* measure(jsonResponse(item.expected), item)).outcome).toBe('ok');
  }),
);

it.effect('the actual fixed schedule covers every admitted case with balanced measured categories', () =>
  Effect.gen(function* balancedCoverage() {
    const schedule = yield* buildSearchProbeSchedule(corpus);
    expect(schedule).toHaveLength(500);
    expect(new Set(schedule.map((item) => item.id)).size).toBe(corpus.cases.length);
    const empty = yield* requireFirst(corpus.cases.filter((item) => item.category === 'empty-hit'));
    expect(schedule.filter((item) => item.category === 'empty-hit').length).toBeLessThanOrEqual(72);
    const other = corpus.cases.filter((item) => item.category !== 'empty-hit');
    for (const length of [80, 500]) {
      const invalidCorpus = {
        ...corpus,
        cases: [...Array.from({ length }, (_, index) => ({ ...empty, id: `extra-empty-${index}` })), ...other],
      };
      expect(Exit.isFailure(yield* Effect.exit(validateCorpus(invalidCorpus)))).toBe(true);
    }
  }),
);

it.live('five C1/C5 rounds execute all 1000 full requests; unverified work cannot pass the SLO', () =>
  Effect.gen(function* runScriptedProfiles() {
    const samples: Attempt[] = [];
    const ids = new Set<string>();
    let active = 0;
    let maxActive = 0;
    const http = HttpClient.make((request) =>
      Effect.gen(function* scriptedSearch() {
        active += 1;
        maxActive = Math.max(active, maxActive);
        ids.add(request.headers[requestIdHeader] ?? '');
        const body = yield* requestBody(request);
        const matched = findScriptedCase(body.query);
        if (matched === undefined) {
          return yield* Effect.die('The scripted transport received an unknown query.');
        }
        yield* Effect.yieldNow;
        active -= 1;
        return HttpClientResponse.fromWeb(request, Response.json(matched.expected, { headers: jsonHeaders }));
      }),
    );
    const approval = yield* approvalFor(liveCorpus);
    yield* runProbe(liveCorpus, approval, cookie, (sample) => {
      samples.push(sample);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(samples.length).toBe(1000);
    expect(ids.size).toBe(1000);
    expect(new Set(samples.map((sample) => sample.querySha256)).size).toBe(1000);
    expect(samples.every((sample) => sample.outcome === 'ok')).toBe(true);
    expect(maxActive).toBe(5);
    const report = yield* summarize(samples, liveCorpus);
    expect(report.gate).toBe(false);
    expect(report.measurementComplete).toBe(true);
    expect(report.uncachedWorkVerification).toBe('unknown');
    expect(report.samples.length).toBe(1000);
    expect(report.countsByResourceType).toEqual(corpus.countsByResourceType);
    for (const profile of report.profiles) {
      expect(profile.bytes).toBeGreaterThan(0);
      expect(profile.correct).toBe(500);
      expect(profile.counts).toEqual({ ok: 500 });
      expect(profile.errors).toBe(0);
      expect(profile.oracleChecked).toBe(500);
      expect(profile.revision).toBe(liveCorpus.pins.compositionRevision);
      expect(profile.retries).toBe(0);
      expect(profile.rounds.map((round) => round.correct)).toEqual([100, 100, 100, 100, 100]);
      expect(profile.workVerified).toBe(0);
    }
    const evidence: WorkEvidence = {
      corpusSha256: yield* corpusHash(liveCorpus),
      observations: samples.map((sample) => ({
        requestId: sample.requestId,
        work: {
          authorizationChecks: 1,
          candidateCount: 1,
          eligibleProviders: ['fixture-provider'],
          executedProviders: ['fixture-provider'],
          providerRetries: 0,
          queryCacheHits: 0,
          retrievals: 1,
          rpcCalls: 1,
          singleflightReuses: 0,
          sqlCalls: 1,
        },
      })),
      pins: liveCorpus.pins,
      source: 'scripted fixture counter; NOT live database proof',
    };
    const verified = yield* summarize(samples, liveCorpus, evidence);
    expect(verified.profiles.every((profile) => profile.workVerified === 500)).toBe(true);
    expect(
      (yield* summarize(samples, liveCorpus, { ...evidence, observations: evidence.observations.slice(1) })).gate,
    ).toBe(false);
    expect((yield* summarize(samples, liveCorpus, { ...evidence, corpusSha256: 'f'.repeat(64) })).gate).toBe(false);
    expect(
      (yield* summarize(samples, liveCorpus, {
        ...evidence,
        observations: evidence.observations.map((observation) => ({
          ...observation,
          work: { ...observation.work, singleflightReuses: 1 },
        })),
      })).gate,
    ).toBe(false);
    expect(
      (yield* summarize(samples, liveCorpus, {
        ...evidence,
        observations: [...evidence.observations, yield* requireFirst(evidence.observations)],
      })).gate,
    ).toBe(false);
    expect((yield* summarize(samples, corpus, { ...evidence, corpusSha256: yield* corpusHash(corpus) })).gate).toBe(
      false,
    );
  }),
);
