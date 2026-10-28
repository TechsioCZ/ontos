import { NodeServices } from '@effect/platform-node';
import { DateTime, Duration, Effect, Fiber, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';

import { OutboxWorkerHostStatusSchema } from '../../packages/core-runtime/src/outbox/health.ts';
import type { OutboxWorkerHostStatus } from '../../packages/core-runtime/src/outbox/health.ts';
import {
  admissionShortfalls,
  awaitOutboxAdmission,
  expectedHostOwners,
  probeOutboxHost,
} from '../ci/await-outbox-admission.mts';

const DIGEST = 'd'.repeat(64);
const OTHER_DIGEST = 'e'.repeat(64);
const REVISION = `sha256:${'a'.repeat(64)}`;
const PREVIOUS = 'sha256:previous';
const SHELL = 'shell-super-app';
const INVENTORY = 'inventory';
const STATUS_URL = 'https://outbox-host.invalid/status';
const ADMITTED_AT = DateTime.makeUnsafe('2026-10-28T12:00:00.000Z');

const owner = (appId: string, admitted: Option.Option<string> = Option.some(REVISION), ready = true) => ({
  admittedRevision: admitted,
  appId: Option.some(appId),
  buildMarker: Option.some(`${appId}-build`),
  lastSuccessAt: admitted.pipe(Option.as(ADMITTED_AT)),
  ready,
});

const hostStatus = (
  owners: OutboxWorkerHostStatus['owners'],
  artifactDigest: Option.Option<string> = Option.some(DIGEST),
): OutboxWorkerHostStatus => ({ artifactDigest, owners });

const shortfalls = (status: OutboxWorkerHostStatus) =>
  admissionShortfalls({ expectedOwners: [SHELL, INVENTORY], hostDigest: DIGEST, revision: REVISION, status });

it('admits only the expected artifact with every hosted owner ready under the published revision', () => {
  expect(shortfalls(hostStatus([owner(SHELL), owner(INVENTORY)]))).toEqual([]);
  expect(shortfalls(hostStatus([owner(SHELL), owner(INVENTORY)], Option.some(OTHER_DIGEST)))).toEqual([
    `the host runs artifact ${OTHER_DIGEST}, not ${DIGEST}`,
  ]);
  expect(shortfalls(hostStatus([owner(SHELL), owner(INVENTORY)], Option.none()))).toEqual([
    `the host runs artifact none, not ${DIGEST}`,
  ]);
  expect(shortfalls(hostStatus([owner(SHELL)]))).toEqual([`${INVENTORY} is not hosted`]);
  expect(shortfalls(hostStatus([owner(SHELL), owner(INVENTORY), owner(INVENTORY)]))).toEqual([
    `the host unexpectedly runs ${INVENTORY}`,
  ]);
  expect(
    shortfalls(hostStatus([owner(SHELL), owner(INVENTORY), { ...owner('unreported'), appId: Option.none() }])),
  ).toEqual(['the host unexpectedly runs an unidentified owner']);
  expect(shortfalls(hostStatus([owner(SHELL, Option.some(PREVIOUS)), owner(INVENTORY, Option.none())]))).toEqual([
    `${SHELL} admitted ${PREVIOUS}`,
    `${INVENTORY} admitted no revision`,
  ]);
  // A failed later cycle keeps the admission but drops readiness, so the release keeps waiting.
  expect(shortfalls(hostStatus([owner(SHELL), owner(INVENTORY, Option.some(REVISION), false)]))).toEqual([
    `${INVENTORY} is not ready`,
  ]);
});

const encodeStatus = Schema.encodeSync(Schema.fromJsonString(OutboxWorkerHostStatusSchema));

const statusResponse = (document: Option.Option<OutboxWorkerHostStatus>, destination: URL) =>
  Option.match(document, {
    onNone: () => new Response('', { status: 503 }),
    onSome: (status) =>
      destination.href === STATUS_URL
        ? new Response(encodeStatus(status), { headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 }),
  });

/** A host whose /status answers the given documents in order, repeating the last; none means unreachable. */
const statusClient = (documents: readonly Option.Option<OutboxWorkerHostStatus>[]) =>
  Effect.map(Ref.make(0), (served) =>
    HttpClient.make((request, destination) =>
      Ref.getAndUpdate(served, (count) => count + 1).pipe(
        Effect.map((count) =>
          HttpClientResponse.fromWeb(
            request,
            statusResponse(documents[Math.min(count, documents.length - 1)] ?? Option.none(), destination),
          ),
        ),
      ),
    ),
  );

it.effect('waits through a restart until every hosted owner admits the published revision', () =>
  Effect.gen(function* awaitRestartedHost() {
    const client = yield* statusClient([
      Option.none(),
      Option.some(hostStatus([owner(SHELL, Option.some(PREVIOUS)), owner(INVENTORY)], Option.some(OTHER_DIGEST))),
      Option.some(hostStatus([owner(SHELL), owner(INVENTORY, Option.none(), false)])),
      Option.some(hostStatus([owner(SHELL), owner(INVENTORY)])),
    ]);
    const admission = yield* awaitOutboxAdmission({
      expectedOwners: [SHELL, INVENTORY],
      hostDigest: DIGEST,
      revision: REVISION,
      timeout: Duration.seconds(20),
      url: STATUS_URL,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
    yield* TestClock.adjust('6 seconds');
    const admitted = yield* Fiber.join(admission);
    expect(admitted.owners.map(({ admittedRevision }) => admittedRevision)).toEqual([
      Option.some(REVISION),
      Option.some(REVISION),
    ]);
  }),
);

it.effect('fails with the last shortfall when the host never admits the revision', () =>
  Effect.gen(function* rejectStaleHost() {
    const client = yield* statusClient([
      Option.some(hostStatus([owner(SHELL, Option.some(PREVIOUS)), owner(INVENTORY)])),
    ]);
    const admission = yield* awaitOutboxAdmission({
      expectedOwners: [SHELL, INVENTORY],
      hostDigest: DIGEST,
      revision: REVISION,
      timeout: Duration.seconds(10),
      url: STATUS_URL,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip, Effect.forkChild);
    yield* TestClock.adjust('12 seconds');
    const failure = yield* Fiber.join(admission);
    expect(failure.message).toContain(`did not admit revision ${REVISION}`);
    expect(failure.message).toContain(`${SHELL} admitted ${PREVIOUS}`);
  }),
);

it.effect('probes whether the live host runs the artifact without failing on an unreachable host', () =>
  Effect.gen(function* probeLiveHost() {
    const live = yield* statusClient([Option.some(hostStatus([owner(SHELL)]))]);
    const probe = (hostDigest: string) =>
      probeOutboxHost({ hostDigest, url: STATUS_URL }).pipe(Effect.provideService(HttpClient.HttpClient, live));
    expect(yield* probe(DIGEST)).toEqual({ artifactDigest: Option.some(DIGEST), matches: true, reachable: true });
    expect(yield* probe(OTHER_DIGEST)).toEqual({
      artifactDigest: Option.some(DIGEST),
      matches: false,
      reachable: true,
    });
    const down = yield* statusClient([Option.none()]);
    expect(
      yield* probeOutboxHost({ hostDigest: DIGEST, url: STATUS_URL }).pipe(
        Effect.provideService(HttpClient.HttpClient, down),
      ),
    ).toEqual({ artifactDigest: Option.none(), matches: false, reachable: false });
  }),
);

it.effect('expects the Core owner and every topology owner the generated host compiles', () =>
  Effect.gen(function* topologyOwners() {
    const owners = yield* expectedHostOwners;
    expect(owners[0]).toBe(SHELL);
    expect(owners).toContain(INVENTORY);
    expect(new Set(owners).size).toBe(owners.length);
  }).pipe(Effect.provide(NodeServices.layer)),
);
