import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ApplicationMigrationObservation, ApplicationMigrationPlan } from '../application-migration-plan.mts';
import {
  assertSameApplicationMigrationTargets,
  reconcileApplicationMigrationOwner,
} from '../application-migration-runtime.mts';
import type { NativeMigrationTarget } from '../application-migration-runtime.mts';

const first = { hash: 'a'.repeat(64), name: '20260101000000_first' };
const second = { hash: 'b'.repeat(64), name: '20260102000000_second' };
const third = { hash: 'c'.repeat(64), name: '20260103000000_third' };
const before: ApplicationMigrationObservation = {
  catalogFingerprint: 'd'.repeat(64),
  entries: [first],
  journalExists: true,
  journalName: '__drizzle_migrations_example',
  ownerId: 'example',
  schemaEvidence: 'observed-journal',
  schemasPresent: ['example'],
};
const planned: ApplicationMigrationPlan['owners'][number] = {
  before,
  migrate: true,
  ownerId: before.ownerId,
  pendingMigrations: [second, third],
  throughMigration: third.name,
  verification: 'pending',
  verify: true,
};
const committed: ApplicationMigrationObservation = {
  ...before,
  catalogFingerprint: 'e'.repeat(64),
  entries: [first, second, third],
};

it.effect('requires the actual owner verifier before recognizing a committed uncertain step', () =>
  Effect.gen(function* verifiesCommittedOutcome() {
    let verifications = 0;
    const outcome = yield* reconcileApplicationMigrationOwner(
      planned,
      committed,
      Effect.sync(() => {
        verifications += 1;
      }),
    );
    expect(outcome).toBe('committed');
    expect(verifications).toBe(1);
  }),
);

it.effect('does not claim completion when the journal committed but its owner verifier fails', () =>
  Effect.gen(function* unavailableOwnerVerifier() {
    const failure = yield* reconcileApplicationMigrationOwner(
      planned,
      committed,
      Effect.fail('owner-verifier-unavailable'),
    ).pipe(Effect.flip);
    expect(failure).toBe('owner-verifier-unavailable');
  }),
);

it.effect('recognizes rollback only when both original journal and schema evidence are unchanged', () =>
  Effect.gen(function* unchangedRollbackEvidence() {
    let verifications = 0;
    const outcome = yield* reconcileApplicationMigrationOwner(
      planned,
      before,
      Effect.sync(() => {
        verifications += 1;
      }),
    );
    expect(outcome).toBe('uncommitted');
    expect(verifications).toBe(0);
  }),
);

it.effect('accepts an empty bookkeeping table left outside the rolled-back owner transaction', () =>
  Effect.gen(function* emptyJournalAfterRollback() {
    const absent: ApplicationMigrationObservation = {
      ...before,
      entries: [],
      journalExists: false,
      schemaEvidence: 'absent',
      schemasPresent: [],
    };
    const outcome = yield* reconcileApplicationMigrationOwner(
      { ...planned, before: absent },
      { ...absent, journalExists: true },
      Effect.die('Rollback must not claim owner verification'),
    );
    expect(outcome).toBe('uncommitted');
  }),
);

const inconsistentObservations: readonly ApplicationMigrationObservation[] = [
  { ...committed, entries: [first, second] },
  { ...committed, entries: [first, second, { ...third, hash: 'f'.repeat(64) }] },
  { ...before, catalogFingerprint: 'f'.repeat(64) },
  { ...committed, schemaEvidence: 'inconsistent', schemasPresent: [] },
  { ...committed, ownerId: 'another-owner' },
  { ...committed, journalName: '__drizzle_migrations_another_owner' },
];
for (const [index, observation] of inconsistentObservations.entries()) {
  it.effect(`refuses uncertain journal/schema evidence ${index + 1} before verifier or replay`, () =>
    Effect.gen(function* refusesInconsistentOutcome() {
      let verifications = 0;
      const failure = yield* reconcileApplicationMigrationOwner(
        planned,
        observation,
        Effect.sync(() => {
          verifications += 1;
        }),
      ).pipe(Effect.flip);
      expect(failure.reason.length).toBeGreaterThan(0);
      expect(verifications).toBe(0);
    }),
  );
}

const target: NativeMigrationTarget = {
  database: 'native_migration_fixture',
  databaseKind: 'primary',
  databaseOid: '16384',
  host: 'vpn-database-host',
  port: 5432,
  systemIdentifier: '7390000000000000001',
  user: 'fixture_admin',
};

it.effect('binds migration evidence to the same physical database across network aliases', () =>
  assertSameApplicationMigrationTargets([target], [{ ...target, host: 'internal-database-host', port: 5433 }]),
);

const changedTargets: readonly (readonly NativeMigrationTarget[])[] = [
  [{ ...target, databaseOid: '16385' }],
  [{ ...target, systemIdentifier: '7390000000000000002' }],
  [{ ...target, database: 'another_database' }],
  [{ ...target, user: 'another_admin' }],
  [{ ...target, databaseKind: 'portal-auth' }],
  [target, target],
  [],
];
for (const [index, observed] of changedTargets.entries()) {
  it.effect(`rejects a changed or incomplete native database binding ${index + 1}`, () =>
    Effect.gen(function* refusesDifferentNativeTarget() {
      const failure = yield* assertSameApplicationMigrationTargets([target], observed).pipe(Effect.flip);
      expect(failure.reason.length).toBeGreaterThan(0);
    }),
  );
}
