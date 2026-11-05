import { Deferred, Effect, Fiber, Option, Ref, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessOperationId, AccessScopeId } from '../../src/access/ids.ts';
import { lifecycleRefusal } from '../../src/access/lifecycle/errors.ts';
import {
  AccessWriteJournalPort,
  openOperationJournal,
  acquireScopeFence,
  advanceOperationJournal,
  recoverAccessWrite,
  releaseScopeFence,
  runAccessWrite,
  validateAccessChange,
} from '../../src/access/lifecycle/fence.ts';
import type {
  AccessChangeReceipt,
  AccessWriteJournalPortService,
  AccessWriteRequest,
  FenceAcquireOutcome,
  FenceReleaseOutcome,
} from '../../src/access/lifecycle/fence.ts';
import type { OperationJournal, ScopeFence } from '../../src/access/model.ts';
import { clockDates, dateAt, digestOf, ids } from './access-lifecycle-support.ts';

interface Harness {
  readonly calls: Ref.Ref<readonly string[]>;
  readonly fences: Ref.Ref<ReadonlyMap<AccessScopeId, ScopeFence>>;
  readonly journals: Ref.Ref<ReadonlyMap<AccessOperationId, OperationJournal>>;
  readonly port: AccessWriteJournalPortService;
}

const makeHarness = Effect.gen(function* makeHarnessEffect() {
  const calls = yield* Ref.make<readonly string[]>([]);
  const fences = yield* Ref.make<ReadonlyMap<AccessScopeId, ScopeFence>>(new Map());
  const journals = yield* Ref.make<ReadonlyMap<AccessOperationId, OperationJournal>>(new Map());
  const record = (entry: string) => Ref.update(calls, (current) => [...current, entry]);
  const port: AccessWriteJournalPortService = {
    acquireFence: (command) =>
      record(`acquireFence ${command.expectedRevision}`).pipe(
        Effect.andThen(
          Ref.modify(
            fences,
            (stored): readonly [FenceAcquireOutcome | undefined, ReadonlyMap<AccessScopeId, ScopeFence>] => {
              const found = stored.get(command.scopeId);
              if (found === undefined) {
                return [undefined, stored];
              }
              return found.state === 'Ready' && found.revision === command.expectedRevision
                ? [
                    {
                      _tag: 'Acquired',
                      fence: {
                        ...found,
                        owningOperationId: command.operationId,
                        revision: found.revision + 1,
                        state: 'Changing',
                      },
                    },
                    new Map(stored).set(command.scopeId, {
                      ...found,
                      owningOperationId: command.operationId,
                      revision: found.revision + 1,
                      state: 'Changing',
                    }),
                  ]
                : [{ _tag: 'Conflict', fence: found }, stored];
            },
          ),
        ),
        Effect.andThen((outcome) =>
          outcome === undefined
            ? Effect.fail(lifecycleRefusal('fence_unavailable', `Scope ${command.scopeId} has no fence`))
            : Effect.succeed(outcome),
        ),
      ),
    readFence: (command) =>
      record(`readFence ${command.scopeId} ${command.tenantId}`).pipe(
        Effect.andThen(Ref.get(fences)),
        Effect.map((stored) => Option.fromUndefinedOr(stored.get(command.scopeId))),
      ),
    readJournal: (command) =>
      record(`readJournal ${command.operationId} ${command.tenantId}`).pipe(
        Effect.andThen(Ref.get(journals)),
        Effect.map((stored) => Option.fromUndefinedOr(stored.get(command.operationId))),
      ),
    releaseFence: (command) =>
      record(`releaseFence ${command.expectedRevision}`).pipe(
        Effect.andThen(
          Ref.modify(
            fences,
            (stored): readonly [FenceReleaseOutcome | undefined, ReadonlyMap<AccessScopeId, ScopeFence>] => {
              const found = stored.get(command.scopeId);
              if (found === undefined) {
                return [undefined, stored];
              }
              const heldByOperation =
                found.state === 'Changing' &&
                found.revision === command.expectedRevision &&
                found.owningOperationId === command.operationId;
              const { owningOperationId: _released, ...ready } = found;
              const released: ScopeFence = { ...ready, revision: found.revision + 1, state: 'Ready' };
              return heldByOperation
                ? [{ _tag: 'Released', fence: released }, new Map(stored).set(command.scopeId, released)]
                : [{ _tag: 'Conflict', fence: found }, stored];
            },
          ),
        ),
        Effect.andThen((outcome) =>
          outcome === undefined
            ? Effect.fail(lifecycleRefusal('fence_unavailable', `Scope ${command.scopeId} has no fence`))
            : Effect.succeed(outcome),
        ),
      ),
    writeJournal: (journal) =>
      record(`writeJournal ${journal.phase}`).pipe(
        Effect.andThen(Ref.update(journals, (stored) => new Map(stored).set(journal.operationId, journal))),
      ),
  };
  return { calls, fences, journals, port };
});

const readyFence = (scopeNumber: number): ScopeFence => ({
  revision: 1,
  scopeId: ids.scope(scopeNumber),
  state: 'Ready',
  tenantId: ids.tenant(1),
});

const seedFence = (harness: Harness, fence: ScopeFence) =>
  Ref.update(harness.fences, (stored) => new Map(stored).set(fence.scopeId, fence));

const seededJournal = (
  operationId: AccessOperationId,
  phase: OperationJournal['phase'],
  startedAt: Date,
): OperationJournal => ({
  commandDigest: digestOf('a'),
  operationId,
  phase,
  scopeId: ids.scope(1),
  startedAt,
  tenantId: ids.tenant(1),
  updatedAt: startedAt,
});

const writeRequest = (fixture: {
  readonly operationId: AccessOperationId;
  readonly receipt: AccessWriteRequest['change'];
  readonly scopeNumber?: number;
  readonly token: string;
}): AccessWriteRequest => ({
  change: fixture.receipt,
  commandDigest: digestOf('a'),
  operationId: fixture.operationId,
  project: () => Effect.succeed(fixture.token),
  scopeId: ids.scope(fixture.scopeNumber ?? 1),
  tenantId: ids.tenant(1),
});

const receiptOf = () => validateAccessChange([{ check: 'noop', run: Effect.void }]);

it.effect('keeps exactly one writer on a scope and lets the next one run after the release', () =>
  Effect.gen(function* oneWriterPerScope() {
    const harness = yield* makeHarness;
    yield* seedFence(harness, readyFence(1));
    const receipt = yield* receiptOf();
    const projecting = Deferred.makeUnsafe<null>();
    const release = Deferred.makeUnsafe<null>();
    const first = yield* runAccessWrite({
      ...writeRequest({ operationId: ids.operation(1), receipt, token: 'token-1' }),
      project: () =>
        Deferred.succeed(projecting, null).pipe(Effect.andThen(Deferred.await(release)), Effect.as('token-1')),
    }).pipe(Effect.provideService(AccessWriteJournalPort, harness.port), Effect.forkChild);

    yield* Deferred.await(projecting);
    const blocked = yield* Effect.flip(
      runAccessWrite(writeRequest({ operationId: ids.operation(2), receipt, token: 'token-2' })).pipe(
        Effect.provideService(AccessWriteJournalPort, harness.port),
      ),
    );
    expect(blocked.code).toBe('fence_held_by_other_operation');

    yield* Deferred.succeed(release, null);
    const firstResult = yield* Fiber.join(first);
    expect(firstResult.projectionToken).toBe('token-1');
    const fence = yield* Ref.get(harness.fences).pipe(Effect.map((stored) => stored.get(ids.scope(1))));
    expect(fence?.state).toBe('Ready');

    const second = yield* runAccessWrite(
      writeRequest({ operationId: ids.operation(3), receipt, token: 'token-3' }),
    ).pipe(Effect.provideService(AccessWriteJournalPort, harness.port));
    expect(second.phase).toBe('committed');
  }),
);

it.effect('refuses the second of two writers that read the same revision and race for the fence', () =>
  Effect.gen(function* oneOfTwoRacingWritersWins() {
    const harness = yield* makeHarness;
    yield* seedFence(harness, readyFence(1));
    const receipt = yield* receiptOf();
    // Both writers read the fence before either one compares and sets it: the lost-update window the
    // sequential test above never enters. Only a compare-and-set in the port can close it.
    const bothRead = Deferred.makeUnsafe<null>();
    const reads = yield* Ref.make(0);
    const projections = yield* Ref.make(0);
    const racingPort: AccessWriteJournalPortService = {
      ...harness.port,
      // Read, count, and wait until both writers hold the revision they read.
      readFence: (command) =>
        harness.port.readFence(command).pipe(
          Effect.tap(() =>
            Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.flatMap((seen) => (seen >= 2 ? Deferred.succeed(bothRead, null) : Effect.succeed(false))),
            ),
          ),
          Effect.tap(() => Deferred.await(bothRead)),
        ),
    };
    const race = (operationId: AccessOperationId, token: string) =>
      runAccessWrite({
        ...writeRequest({ operationId, receipt, token }),
        project: () => Ref.update(projections, (count) => count + 1).pipe(Effect.as(token)),
      }).pipe(Effect.provideService(AccessWriteJournalPort, racingPort), Effect.result);
    const results = yield* Effect.all([race(ids.operation(1), 'token-1'), race(ids.operation(2), 'token-2')], {
      concurrency: 2,
    });

    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    const refused = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));
    // Whichever writer read last wins the compare-and-set; the other one stops on the fence. It may
    // still see the winner's held fence or the fence it already released at a newer revision.
    expect(refused.map((error) => error.code)).toHaveLength(1);
    expect(['fence_held_by_other_operation', 'fence_revision_conflict']).toContain(refused[0]?.code);

    // Exactly one operation projected: the loser never reaches its projection at all.
    expect(yield* Ref.get(projections)).toBe(1);
    const journals = [...(yield* Ref.get(harness.journals)).values()];
    expect(journals.filter((journal) => journal.phase === 'committed')).toHaveLength(1);
    expect(yield* Ref.get(harness.calls)).toContain('acquireFence 1');
    const fence = yield* Ref.get(harness.fences).pipe(Effect.map((stored) => stored.get(ids.scope(1))));
    expect(fence?.state).toBe('Ready');
    expect(fence?.revision).toBe(3);
  }),
);

it.effect('validates before it locks the scope and never writes on an empty or failing validation', () =>
  Effect.gen(function* validationComesFirst() {
    const harness = yield* makeHarness;
    yield* seedFence(harness, readyFence(1));
    const receipt = yield* receiptOf();

    const missing = yield* Effect.flip(validateAccessChange([]));
    expect(missing.code).toBe('change_validation_missing');

    const failing = yield* Effect.flip(
      validateAccessChange([
        { check: 'envelope', run: lifecycleRefusal('delegation_self_grant', 'A delegation is never self-granted') },
      ]),
    );
    expect(failing.code).toBe('delegation_self_grant');
    expect(yield* Ref.get(harness.calls)).toEqual([]);

    const unreceipted = yield* Effect.flip(
      runAccessWrite({
        ...writeRequest({ operationId: ids.operation(1), receipt, token: 'token' }),
        // @ts-expect-error A change without a receipt is not a validated change.
        change: { checks: [] },
      }).pipe(Effect.provideService(AccessWriteJournalPort, harness.port)),
    );
    expect(unreceipted.code).toBe('change_validation_missing');
    expect(yield* Ref.get(harness.calls)).toEqual([]);
  }),
);

it.effect('keeps every journal keyed to its operation and refuses a foreign advance', () =>
  Effect.gen(function* journalsBelongToTheirOperation() {
    const harness = yield* makeHarness;
    const journal = yield* openOperationJournal({
      commandDigest: digestOf('a'),
      operationId: ids.operation(1),
      scopeId: ids.scope(1),
      startedAt: dateAt(Date.UTC(2026, 10, 3, 9)),
      tenantId: ids.tenant(1),
    });
    const foreign = yield* Effect.flip(
      advanceOperationJournal({
        current: journal,
        operationId: ids.operation(2),
        phase: 'fenced',
        updatedAt: dateAt(Date.UTC(2026, 10, 3, 10)),
      }),
    );
    expect(foreign.code).toBe('operation_not_owned');

    const completed = yield* advanceOperationJournal({
      current: journal,
      operationId: ids.operation(1),
      phase: 'fenced',
      updatedAt: dateAt(Date.UTC(2026, 10, 3, 10)),
    });
    const terminal = yield* advanceOperationJournal({
      current: completed,
      operationId: ids.operation(1),
      phase: 'committed',
      projectionToken: 'token-1',
      updatedAt: dateAt(Date.UTC(2026, 10, 3, 11)),
    });
    const regression = yield* Effect.flip(
      advanceOperationJournal({
        current: terminal,
        operationId: ids.operation(1),
        phase: 'projected',
        updatedAt: dateAt(Date.UTC(2026, 10, 3, 12)),
      }),
    );
    expect(regression.code).toBe('operation_terminal');

    // Recovery never invents an operation: it resumes the journal that exists.
    const receipt = yield* receiptOf();
    const unknown = yield* Effect.flip(
      recoverAccessWrite(writeRequest({ operationId: ids.operation(9), receipt, token: 'token-9' })).pipe(
        Effect.provideService(AccessWriteJournalPort, harness.port),
      ),
    );
    expect(unknown.code).toBe('operation_unknown');
  }),
);

it.effect('resumes the owning operation only, and never projects a committed operation twice', () =>
  Effect.gen(function* recoveryResumesForward() {
    const harness = yield* makeHarness;
    const receipt = yield* receiptOf();
    const { now } = yield* clockDates;
    yield* seedFence(harness, {
      owningOperationId: ids.operation(1),
      revision: 2,
      scopeId: ids.scope(1),
      state: 'Changing',
      tenantId: ids.tenant(1),
    });
    yield* Ref.update(harness.journals, (stored) =>
      new Map(stored).set(ids.operation(1), seededJournal(ids.operation(1), 'fenced', now)),
    );

    const recovered = yield* recoverAccessWrite(
      writeRequest({ operationId: ids.operation(1), receipt, token: 'token-recovered' }),
    ).pipe(Effect.provideService(AccessWriteJournalPort, harness.port));
    expect(recovered.projectionToken).toBe('token-recovered');

    const committed = yield* Ref.get(harness.journals).pipe(Effect.map((stored) => stored.get(ids.operation(1))));
    expect(committed?.phase).toBe('committed');

    const replay = yield* runAccessWrite(
      writeRequest({ operationId: ids.operation(1), receipt, token: 'token-again' }),
    ).pipe(Effect.provideService(AccessWriteJournalPort, harness.port));
    expect(replay.resumed).toBe(true);
    expect(replay.projectionToken).toBe('token-recovered');
    const phases = (yield* Ref.get(harness.calls)).filter((call) => call.startsWith('writeJournal'));
    expect(phases).toEqual(['writeJournal projected', 'writeJournal committed']);
  }),
);

it('never lets a caller build a change receipt by hand', () => {
  // @ts-expect-error A receipt is proof of validation: only validateAccessChange can produce one.
  const forged: AccessChangeReceipt = { checks: ['noop'] };
  expect(forged.checks).toEqual(['noop']);
});

it.effect('resumes only the journal of the same command in the same scope', () =>
  Effect.gen(function* resumedJournalMustMatch() {
    const harness = yield* makeHarness;
    yield* seedFence(harness, readyFence(1));
    const receipt = yield* receiptOf();
    const { now } = yield* clockDates;
    const seedJournal = (overrides: Partial<OperationJournal>) =>
      Ref.update(harness.journals, (stored) =>
        new Map(stored).set(ids.operation(1), { ...seededJournal(ids.operation(1), 'fenced', now), ...overrides }),
      );

    // Another command in the same scope: committing its projection would be somebody else's work.
    yield* seedJournal({ commandDigest: digestOf('b') });
    const otherCommand = yield* Effect.flip(
      runAccessWrite(writeRequest({ operationId: ids.operation(1), receipt, token: 'token' })).pipe(
        Effect.provideService(AccessWriteJournalPort, harness.port),
      ),
    );
    expect(otherCommand.code).toBe('operation_command_mismatch');

    // The same command in another scope is a different operation, whatever the id says.
    yield* seedJournal({ scopeId: ids.scope(2) });
    const otherScope = yield* Effect.flip(
      runAccessWrite(writeRequest({ operationId: ids.operation(1), receipt, token: 'token' })).pipe(
        Effect.provideService(AccessWriteJournalPort, harness.port),
      ),
    );
    expect(otherScope.code).toBe('operation_command_mismatch');

    // Neither mismatch reaches the fence or the projection.
    expect(yield* Ref.get(harness.calls)).not.toContain('acquireFence 1');
  }),
);

it.effect('marks a failed projection, releases the fence and refuses to rerun the failed operation', () =>
  Effect.gen(function* failedProjectionIsTerminal() {
    const harness = yield* makeHarness;
    yield* seedFence(harness, readyFence(1));
    const receipt = yield* receiptOf();
    const failed = yield* Effect.flip(
      runAccessWrite({
        ...writeRequest({ operationId: ids.operation(1), receipt, token: 'unused' }),
        project: () => Effect.fail(lifecycleRefusal('fence_store_unavailable', 'The projection write failed')),
      }).pipe(Effect.provideService(AccessWriteJournalPort, harness.port)),
    );
    expect(failed.code).toBe('fence_store_unavailable');
    const journal = yield* Ref.get(harness.journals).pipe(Effect.map((stored) => stored.get(ids.operation(1))));
    expect(journal?.phase).toBe('failed');
    const fence = yield* Ref.get(harness.fences).pipe(Effect.map((stored) => stored.get(ids.scope(1))));
    expect(fence?.state).toBe('Ready');

    const rerun = yield* Effect.flip(
      runAccessWrite(writeRequest({ operationId: ids.operation(1), receipt, token: 'token' })).pipe(
        Effect.provideService(AccessWriteJournalPort, harness.port),
      ),
    );
    expect(rerun.code).toBe('operation_already_failed');
  }),
);

it.effect('refuses to write without a fence row and while the scope is unavailable', () =>
  Effect.gen(function* noFenceMeansNoWrite() {
    const missing = yield* Effect.flip(
      acquireScopeFence({
        current: Option.none(),
        operationId: ids.operation(1),
        scopeId: ids.scope(1),
        tenantId: ids.tenant(1),
      }),
    );
    expect(missing.code).toBe('fence_unavailable');

    const unavailable = yield* Effect.flip(
      acquireScopeFence({
        current: Option.some<ScopeFence>({
          revision: 3,
          scopeId: ids.scope(1),
          state: 'Unavailable',
          tenantId: ids.tenant(1),
        }),
        operationId: ids.operation(1),
        scopeId: ids.scope(1),
        tenantId: ids.tenant(1),
      }),
    );
    expect(unavailable.code).toBe('fence_unavailable');

    const foreignOwner = yield* Effect.flip(
      releaseScopeFence({
        current: {
          owningOperationId: ids.operation(2),
          revision: 2,
          scopeId: ids.scope(1),
          state: 'Changing',
          tenantId: ids.tenant(1),
        },
        operationId: ids.operation(1),
      }),
    );
    expect(foreignOwner.code).toBe('fence_not_held_by_operation');
  }),
);
