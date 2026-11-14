import { Effect, Fiber, Layer, Option, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { LiveChangeHub, LiveChangeHubLive } from '../../../api/live-changes/hub.ts';
import { LiveChangeTail } from '../../../api/live-changes/listener.ts';
import type { LiveChangeSink } from '../../../api/live-changes/listener.ts';
import { SHELL_APP, appsForChange } from '../../../api/live-changes/live-scope.ts';
import type { LiveScope } from '../../../api/live-changes/live-scope.ts';

const tenantId = '0b9c7f3e-4e9a-4d5c-9f51-2a1c8e7d6b40';
const otherTenantId = '1c8d6e2f-5a4b-4c3d-8e7f-6a5b4c3d2e1f';
const legalEntityId = '5d2f4a91-7c3b-4e8f-a6d0-1b9e8c7f2a35';
const otherLegalEntityId = '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928';

const scope = (overrides: Partial<LiveScope> = {}): LiveScope => ({
  allowedApps: new Set(['crm', 'sales-pipeline', SHELL_APP]),
  legalEntityId,
  moduleApps: new Map([
    ['crm', 'crm'],
    ['sales.pipeline', 'sales-pipeline'],
    ['finance.billing', 'finance-billing'],
  ]),
  principalId: 'principal-a',
  tenantId,
  ...overrides,
});

it('filters a change by tenant, legal entity and the module APIs the session may call', () => {
  expect(appsForChange(scope(), { legalEntityId, moduleKeys: ['crm', 'sales.pipeline'], tenantId })).toEqual([
    'crm',
    'sales-pipeline',
  ]);
  // Tenant-wide changes reach every legal entity of the tenant.
  expect(appsForChange(scope(), { legalEntityId: null, moduleKeys: ['crm'], tenantId })).toEqual(['crm']);
  expect(appsForChange(scope(), { legalEntityId: otherLegalEntityId, moduleKeys: ['crm'], tenantId })).toEqual([]);
  expect(appsForChange(scope(), { legalEntityId, moduleKeys: ['crm'], tenantId: otherTenantId })).toEqual([]);
  // Not in the session's composition: nothing, not even the fact that it changed.
  expect(appsForChange(scope(), { legalEntityId, moduleKeys: ['finance.billing'], tenantId })).toEqual([]);
  // Core-owned data maps to the Shell's own stores.
  expect(appsForChange(scope(), { legalEntityId, moduleKeys: ['core.identity'], tenantId })).toEqual([SHELL_APP]);
});

/** A hub over a tail that records its sink, so tests publish exactly as the database listener would. */
const recordingHub = () => {
  const sinks: LiveChangeSink[] = [];
  const starts = { count: 0 };
  const layer = LiveChangeHubLive.pipe(
    Layer.provide(
      Layer.succeed(LiveChangeTail, {
        run: (sink) =>
          Effect.sync(() => {
            sinks.push(sink);
            starts.count += 1;
          }).pipe(Effect.andThen(Effect.never)),
      }),
    ),
  );
  const sink = () => sinks.at(0) ?? { publish: () => Effect.void, resetAll: Effect.void };
  return { layer, sink, starts };
};

const open = (connectionScope: LiveScope, lastEventId: Option.Option<string> = Option.none()) =>
  LiveChangeHub.pipe(
    Effect.flatMap((hub) => hub.subscribe(connectionScope, lastEventId)),
    Effect.map(Option.getOrElse(() => Stream.empty)),
  );

/** Lets forked readers register their timers before the clock moves. */
const advance = (millis: number) => TestClock.adjust('1 millis').pipe(Effect.andThen(TestClock.adjust(millis)));

it.effect('coalesces changes per connection into one frame without data', () => {
  const { layer, sink, starts } = recordingHub();
  return Effect.gen(function* coalesce() {
    const frames = yield* open(scope());
    const collected = yield* frames.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
    yield* TestClock.adjust('1 millis');
    expect(starts.count).toBe(1);
    yield* sink().publish({ legalEntityId, moduleKeys: ['crm'], tenantId });
    yield* sink().publish({ legalEntityId, moduleKeys: ['sales.pipeline'], tenantId });
    yield* sink().publish({ legalEntityId: otherLegalEntityId, moduleKeys: ['finance.billing'], tenantId });
    yield* advance(300);
    const output = [...(yield* Fiber.join(collected))];
    expect(output[0]).toMatch(/^retry: \d+\n(?:id: [0-9a-z]+\.0\n)?: connected\n\n$/u);
    expect(output[1]).toMatch(/^id: [0-9a-z]+\.3\nevent: change\ndata: crm,sales-pipeline\n\n$/u);
  }).pipe(Effect.provide(layer));
});

it.effect('sends one reset after missed notifications and a heartbeat while idle', () => {
  const { layer, sink } = recordingHub();
  return Effect.gen(function* reset() {
    const frames = yield* open(scope());
    const collected = yield* frames.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
    yield* TestClock.adjust('1 millis');
    yield* sink().publish({ legalEntityId, moduleKeys: ['crm'], tenantId });
    yield* sink().resetAll;
    yield* advance(300);
    yield* advance(25_000);
    const output = [...(yield* Fiber.join(collected))];
    expect(output.slice(1).map((frame) => frame.replace(/^id: [0-9a-z]+\./u, 'id: '))).toEqual([
      'id: 2\nevent: reset\ndata: all\n\n',
      'id: 2\n: ping\n\n',
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect('resumes a cut stream from its Last-Event-ID, and resets one it cannot account for', () => {
  const { layer, sink } = recordingHub();
  return Effect.gen(function* resume() {
    const first = yield* open(scope()).pipe(
      Effect.flatMap((frames) => frames.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)),
    );
    yield* advance(1);
    const [connected] = [...(yield* Fiber.join(first))];
    const lastEventId = /id: (?<id>\S+)/u.exec(connected ?? '')?.groups?.['id'] ?? '';
    expect(lastEventId).toMatch(/^[0-9a-z]+\.0$/u);
    // While the stream is down: one change it may see, one it may not.
    yield* sink().publish({ legalEntityId, moduleKeys: ['crm'], tenantId });
    yield* sink().publish({ legalEntityId, moduleKeys: ['finance.billing'], tenantId });
    const resumed = yield* open(scope(), Option.some(lastEventId)).pipe(
      Effect.flatMap((frames) => frames.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)),
    );
    yield* advance(1);
    yield* advance(300);
    expect([...(yield* Fiber.join(resumed))].at(1)).toMatch(/^id: [0-9a-z]+\.2\nevent: change\ndata: crm\n\n$/u);
    // Another process (a deploy) or an id older than the remembered changes: the page revalidates everything once.
    const foreign = yield* open(scope(), Option.some('other.1')).pipe(
      Effect.flatMap((frames) => frames.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)),
    );
    yield* advance(1);
    yield* advance(300);
    expect([...(yield* Fiber.join(foreign))].at(1)).toMatch(/event: reset\ndata: all/u);
  }).pipe(Effect.provide(layer));
});

it.effect('shares one change tail and evicts the oldest connection beyond 32 per principal', () => {
  const { layer, starts } = recordingHub();
  return Effect.gen(function* limits() {
    const connections = yield* Effect.forEach(
      Array.from({ length: 33 }, (_, index) => index),
      () => open(scope()).pipe(Effect.flatMap((frames) => Stream.runDrain(frames).pipe(Effect.forkChild))),
      { concurrency: 1 },
    );
    yield* advance(1);
    const hub = yield* LiveChangeHub;
    expect(starts.count).toBe(1);
    expect(yield* hub.connections).toBe(32);
    expect(connections.at(0)?.pollUnsafe()).toBeDefined();
    expect(connections.at(32)?.pollUnsafe()).toBeUndefined();
    // Another principal is not affected by that limit.
    yield* open(scope({ principalId: 'principal-b' })).pipe(
      Effect.flatMap((frames) => Stream.runDrain(frames).pipe(Effect.forkChild)),
    );
    yield* advance(1);
    expect(yield* hub.connections).toBe(33);
  }).pipe(Effect.provide(layer));
});

it.effect('ends a connection after its maximum age so the browser reconnects with a fresh scope', () => {
  const { layer } = recordingHub();
  return Effect.gen(function* maxAge() {
    const frames = yield* open(scope());
    const drained = yield* Stream.runDrain(frames).pipe(Effect.forkChild);
    yield* advance(600_000);
    yield* Fiber.join(drained);
    expect(yield* LiveChangeHub.pipe(Effect.flatMap((hub) => hub.connections))).toBe(0);
  }).pipe(Effect.provide(layer));
});
