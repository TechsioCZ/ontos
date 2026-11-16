import { DateTime, Effect, Option, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, rstest } from 'effect-rstest';

import { applicationCompositionAuthorityUpsert } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../packages/core-runtime/src/modules/active-application-composition-errors.ts';
import type { ActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import {
  ApplicationCompositionSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../packages/core-runtime/src/modules/application-composition.ts';
import { applicationCompositionRevision } from '../active-application-composition.mts';
import { AppHostError, makeCompositionPointer, writeAndHold } from '../zerops/app-host.mts';

const observedAt = 1000;
const validUntil = 100_000;
/** The exact activation as the writer returns it and the host reads it: integer microseconds, as text. */
const ACTIVATION = '1731664800123456';
const OTHER_ACTIVATION = '1731664900654321';

const snapshot = (buildMarker = 'shell-build'): ActiveApplicationCompositionSnapshot => {
  const composition = Schema.decodeSync(ApplicationCompositionSchema)({
    modules: [],
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: { appId: 'shell-super-app', buildMarker },
      federationManifest: { sha256: 'a'.repeat(64), url: 'https://shell.example/mf-manifest.json' },
      runtimeContract: { sha256: 'b'.repeat(64), url: 'https://shell.example/ontos-shell-runtime.json' },
      sharedSingletons: [],
    },
  });
  return {
    composition: { ...composition, revision: applicationCompositionRevision(composition) },
    observedAt: DateTime.makeUnsafe(observedAt),
    validUntil: DateTime.makeUnsafe(validUntil),
  };
};

const leased = (input: ActiveApplicationCompositionSnapshot, lease: number) => ({
  ...input,
  validUntil: DateTime.makeUnsafe(lease),
});

/** A row of the authority as the host reads it. */
interface Row {
  readonly activatedAtMicros: string;
  readonly phase: string;
  readonly revision: string;
  readonly validUntilMillis: number;
}

const rowOf = (input: ActiveApplicationCompositionSnapshot, lease = validUntil): Row => ({
  activatedAtMicros: ACTIVATION,
  phase: 'active',
  revision: input.composition.revision,
  validUntilMillis: lease,
});

/** A pointer over a mutable row, and this host's own committed write of `own` (journal first, hold after commit). */
const hostOver = (initial: Row) =>
  Effect.gen(function* makeHost() {
    const row = yield* Ref.make(initial);
    const reads = yield* Ref.make(0);
    const pointer = yield* makeCompositionPointer(
      Ref.update(reads, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(row)),
        Effect.map((current) => [current]),
      ),
    );
    const writeRow = (next: Row) =>
      Ref.set(row, next).pipe(Effect.as({ activatedAtMicros: next.activatedAtMicros, revision: next.revision }));
    const commit = (own: ActiveApplicationCompositionSnapshot, next: Row) =>
      writeAndHold(pointer, own, (journal) => Effect.andThen(journal, writeRow(next)));
    const refused = new AppHostError({ reason: 'the authority transaction rolled back' });
    const failWrite = (own: ActiveApplicationCompositionSnapshot) =>
      writeAndHold(pointer, own, (journal) => Effect.andThen(journal, Effect.fail(refused))).pipe(Effect.flip);
    return { commit, failWrite, pointer, reads: Ref.get(reads), refused, set: (next: Row) => Ref.set(row, next) };
  });

const servedLeaseSchema = Schema.fromJsonString(Schema.Struct({ validUntil: Schema.DateTimeUtcFromString }));
const leaseOfEncoded = (encoded: string) =>
  DateTime.toEpochMillis(Schema.decodeUnknownSync(servedLeaseSchema)(encoded).validUntil);
/** The lease the served bytes claim (epoch millis), so a test can tell which journaled snapshot was served. */
const servedLease = (served: Option.Option<string>) => served.pipe(Option.map(leaseOfEncoded));
const lease = (millis: number) => Option.some(millis);

it.effect('validates content once at publication while every concurrent fetch re-reads authority', () =>
  Effect.gen(function* reuseValidatedPublication() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const host = yield* hostOver(rowOf(input));
    const digest = rstest.spyOn(globalThis.crypto.subtle, 'digest');
    yield* Effect.addFinalizer(() => Effect.sync(() => digest.mockRestore()));
    yield* host.commit(input, rowOf(input));
    expect(digest).toHaveBeenCalledTimes(1);
    const results = yield* Effect.all(
      Array.from({ length: 27 }, () => host.pointer.load),
      { concurrency: 'unbounded' },
    );
    expect(results.map(servedLease)).toEqual(Array.from({ length: 27 }, () => lease(validUntil)));
    expect(yield* host.reads).toBe(27);
    expect(digest).toHaveBeenCalledTimes(1);
  }),
);

it.effect('keeps phase, revision, hold, lease and expiry checks on every fetch', () =>
  Effect.gen(function* preserveAuthorityChecks() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = rowOf(input);
    const host = yield* hostOver(own);
    yield* host.commit(input, own);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    yield* host.set({ ...own, phase: 'draining' });
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    yield* host.set({ ...own, phase: 'closed' });
    expect(yield* host.pointer.load).toEqual(Option.none());
    yield* host.set({ ...own, revision: 'f'.repeat(64) });
    expect(yield* host.pointer.load).toEqual(Option.none());
    yield* host.set({ ...own, validUntilMillis: validUntil - 1 });
    expect(yield* host.pointer.load).toEqual(Option.none());
    yield* host.set(own);
    // The pointer serves its own validated copy: a caller's later edit cannot extend the lease it serves under.
    expect(Reflect.set(input.validUntil, 'epochMilliseconds', validUntil + 60_000)).toBe(true);
    yield* TestClock.setTime(validUntil);
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('retains only the candidate and preceding publication across authority commits', () =>
  Effect.gen(function* boundPublicationJournal() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const host = yield* hostOver(rowOf(input));
    for (const next of [validUntil, validUntil + 10_000, validUntil + 20_000]) {
      yield* host.commit(leased(input, next), rowOf(input, next));
    }
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil + 20_000));
    yield* host.set(rowOf(input, validUntil + 10_000));
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil + 10_000));
    // The first publication left the journal: nothing it holds claims a lease the row admits.
    yield* host.set(rowOf(input, validUntil));
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('rejects changed content and propagates authority-read failures without serving cached bytes', () =>
  Effect.gen(function* failClosed() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const failure = new AppHostError({ reason: 'authority unavailable' });
    const pointer = yield* makeCompositionPointer(Effect.fail(failure));
    yield* pointer.publish(input);
    yield* pointer.hold({ activatedAtMicros: ACTIVATION, revision: input.composition.revision });
    expect(yield* Effect.flip(pointer.load)).toBe(failure);
    expect(Reflect.set(input.composition.shell.deployment, 'buildMarker', 'tampered')).toBe(true);
    expect(yield* Effect.flip(pointer.publish(input))).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
  }),
);

it.effect('serves after a peer of the same release commits a later lease before its first fetch', () =>
  Effect.gen(function* peerCommitsBeforeFirstFetch() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = rowOf(input);
    const host = yield* hostOver(own);
    // A commits L1; B commits the same revision with L2 right behind it; only then does A's first fetch arrive.
    yield* host.commit(input, own);
    yield* host.set({ ...own, validUntilMillis: validUntil + 60_000 });
    // Its own bytes and its own lease, never the peer's, and never past that lease.
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    yield* TestClock.setTime(validUntil);
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('serves nothing when its own publication fails or rolls back, even under the exact journaled lease', () =>
  Effect.gen(function* failedWriteHoldsNothing() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const host = yield* hostOver(rowOf(input, validUntil + 60_000));
    expect(yield* host.failWrite(input)).toBe(host.refused);
    // The bytes were journaled before the write; neither a later lease nor the exact one admits them without a hold.
    expect(yield* host.pointer.load).toEqual(Option.none());
    yield* host.set(rowOf(input));
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('never serves a renewal candidate whose write failed, even when a later hold names that exact lease', () =>
  Effect.gen(function* failedCandidateInLaterHold() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = rowOf(input);
    const host = yield* hostOver(own);
    yield* host.commit(input, own);
    // Its renewal journals a candidate with L3, and the write fails: the committed L1 is still what it serves.
    const candidateLease = validUntil + 90_000;
    expect(yield* host.failWrite(leased(input, candidateLease))).toBe(host.refused);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    // Another release takes the row at L2, then a peer publishes this revision again in a new hold with lease L3.
    const newer = snapshot('newer').composition.revision;
    yield* host.set({
      activatedAtMicros: OTHER_ACTIVATION,
      phase: 'active',
      revision: newer,
      validUntilMillis: validUntil + 60_000,
    });
    expect(yield* host.pointer.load).toEqual(Option.none());
    yield* host.set({ ...own, activatedAtMicros: '1731665000000001', validUntilMillis: candidateLease });
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('refuses once a different revision took the row, and when its own revision is taken again', () =>
  Effect.gen(function* differentRevisionRefuses() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = rowOf(input);
    const host = yield* hostOver(own);
    yield* host.commit(input, own);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    // Another release took the row: this host still remembers its hold for its own revision, and refuses.
    const newer = snapshot('newer').composition.revision;
    yield* host.set({
      activatedAtMicros: OTHER_ACTIVATION,
      phase: 'active',
      revision: newer,
      validUntilMillis: validUntil + 60_000,
    });
    expect(yield* host.pointer.load).toEqual(Option.none());
    // Its own revision taken again later (a rollback by another host) is a new hold, not the one it wrote.
    yield* host.set({ ...own, activatedAtMicros: '1731665000000001', validUntilMillis: validUntil + 90_000 });
    expect(yield* host.pointer.load).toEqual(Option.none());
    // The remembered activation one microsecond off is another hold too.
    yield* host.set({ ...own, activatedAtMicros: '1731664800123457', validUntilMillis: validUntil + 90_000 });
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('serves the committed lease until its renewal commits, then the renewed one past the old expiry', () =>
  Effect.gen(function* renewals() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = rowOf(input);
    const host = yield* hostOver(own);
    yield* host.commit(input, own);
    // Its renewal journals the renewed snapshot first; until the write commits the row still names L1.
    const renewedLease = validUntil + 30_000;
    const renewed = leased(input, renewedLease);
    yield* host.pointer.publish(renewed);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    // Committed: the same hold (a renewal never moves the activation), the renewed lease.
    yield* host.commit(renewed, { ...own, validUntilMillis: renewedLease });
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(renewedLease));
    // A peer renews with a still later lease: this host keeps serving its own renewed bytes, not the peer's lease.
    yield* host.set({ ...own, validUntilMillis: validUntil + 90_000 });
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(renewedLease));
    // Past the old expiry it still serves the renewed snapshot, and nothing past its own renewed lease.
    yield* TestClock.setTime(validUntil + 1);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(renewedLease));
    yield* TestClock.setTime(renewedLease);
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('refuses in its own hold once the row leaves active or draining', () =>
  Effect.gen(function* holdOutsideAdmission() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = rowOf(input);
    const host = yield* hostOver(own);
    yield* host.commit(input, own);
    const peer = { ...own, validUntilMillis: validUntil + 60_000 };
    yield* host.set({ ...peer, phase: 'draining' });
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    for (const phase of ['sealed', 'migrated']) {
      yield* host.set({ ...peer, phase });
      expect(yield* host.pointer.load).toEqual(Option.none());
    }
    yield* host.set(peer);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
  }),
);

it.effect('refuses a row lease earlier than every journaled one in its hold', () =>
  Effect.gen(function* earlierRowLease() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = rowOf(input);
    const host = yield* hostOver(own);
    yield* host.commit(input, own);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    // Its next renewal journals a later lease before its commit; until then the committed one is served.
    yield* host.pointer.publish(leased(input, validUntil + 60_000));
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    // Every journaled lease is later than the row's: nothing is served.
    yield* host.set({ ...own, validUntilMillis: validUntil - 1 });
    expect(yield* host.pointer.load).toEqual(Option.none());
  }),
);

it.effect('keeps its hold across a peer publication through the real writer, to the microsecond', () =>
  Effect.gen(function* writerKeepsActivation() {
    yield* TestClock.setTime(observedAt);
    const input = snapshot();
    const own = { ...rowOf(input), durableWorkAdmission: 'open' as const, phase: 'active' as const };
    const host = yield* hostOver(own);
    yield* host.commit(input, own);
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
    // A peer of the same release publishes: the writer reads the row through the Date-valued schema (milliseconds)
    // and sends the update it builds. Any activation it wrote would replace the exact moment with another one.
    const read = { ...own, revisionActivatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(1_731_664_800_123)) };
    const { set } = applicationCompositionAuthorityUpsert(read, leased(input, validUntil + 60_000), []);
    expect('revisionActivatedAt' in set).toBe(false);
    yield* host.set({ ...own, validUntilMillis: DateTime.toEpochMillis(DateTime.makeUnsafe(set.validUntil)) });
    expect(servedLease(yield* host.pointer.load)).toEqual(lease(validUntil));
  }),
);
