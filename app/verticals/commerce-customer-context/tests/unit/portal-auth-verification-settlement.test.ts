import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, isSqlError, SqlError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { CommercePortalAuthRecoveryUnavailable } from '../../api/portal-auth/provider/recovery/unavailable.ts';
import { makeCommercePortalAuthRecoveryStore } from '../../src/portal-auth/persistence/portal-auth-recovery-store.ts';
import { commercePortalAuthRelations } from '../../src/portal-auth/persistence/portal-auth-tables.ts';

const now = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-19T00:00:00Z'));
const input = {
  audit: {
    eventType: 'commerce.portal-auth.email-verification-consumed.v1' as const,
    occurredAt: now,
    operation: 'verify-email',
    outcome: 'success' as const,
  },
  now,
  token: Redacted.make('verification-settlement-fixture-only'),
};
const failure = (operation: string) =>
  new SqlError({
    reason: new ConnectionError({
      cause: new Error('Fixture transport unavailable'),
      message: 'Fixture transport unavailable',
      operation,
    }),
  });
const ledger = { expires_at: '2026-10-20T00:00:00Z', id: 'ledger-fixture', value: '7:subject19:person@example.test' };
const rowsFor = (statement: string) => {
  if (statement.startsWith('select')) {
    return [ledger];
  }
  if (statement.startsWith('update')) {
    return [{ id: 'subject' }];
  }
  return [];
};
const makeFixture = (
  execute: (statement: string, parameters: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
  release: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* makeSettlementFixture() {
    const context = yield* Layer.build(
      scriptedPgClientLayer(Effect.acquireRelease(Effect.succeed(testSqlConnection(execute)), () => release)).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const executor = yield* makeWithDefaults({ relations: commercePortalAuthRelations }).pipe(Effect.provide(context));
    return yield* makeCommercePortalAuthRecoveryStore(executor).pipe(
      Effect.provide(commercePortalAuthPlatformCryptoLive),
    );
  });

const diagnosticKey = Context.Service<
  Redacted.Redacted<{
    readonly bodyExit: Option.Option<Exit.Exit<unknown, unknown>>;
    readonly originalCause: Cause.Cause<unknown>;
    readonly settlementCause: Cause.Cause<unknown>;
  }>
>(
  '@app/commerce-customer-context/portal-auth/persistence/portal-auth-recovery-store/VerificationSettlementDiagnostics',
);
const priorAnnotation = Context.Service<string>('verification-settlement-fixture-prior-annotation');

it.effect('maps native COMMIT SqlError defects to the declared verification unavailable failure', () =>
  Effect.scoped(
    Effect.gen(function* commitFailure() {
      const commitError = failure('COMMIT');
      expect(isSqlError(commitError)).toBe(true);
      const statements: string[] = [];
      const store = yield* makeFixture((statement) => {
        statements.push(statement);
        return statement === 'COMMIT' ? Effect.fail(commitError) : Effect.succeed(rowsFor(statement));
      });
      const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
      expect(statements).toContain('COMMIT');
      expect(statements.some((statement) => statement.startsWith('update'))).toBe(true);
      expect(statements.some((statement) => statement.startsWith('delete'))).toBe(true);
      expect(statements.some((statement) => statement.startsWith('insert'))).toBe(true);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && Schema.is(CommercePortalAuthRecoveryUnavailable)(reason.error),
          ),
        ).toBe(true);
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false);
      }
    }),
  ),
);

it.effect('returns the exact bound subject after body writes and acknowledged COMMIT', () =>
  Effect.scoped(
    Effect.gen(function* successfulSettlement() {
      const statements: string[] = [];
      const store = yield* makeFixture((statement) => {
        statements.push(statement);
        return Effect.succeed(rowsFor(statement));
      });
      const result = yield* store.consumeEmailVerificationWithAudit(input);
      expect(result).toEqual(Option.some('subject'));
      expect(statements.some((statement) => statement.startsWith('insert'))).toBe(true);
      expect(statements.at(-1)).toBe('COMMIT');
    }),
  ),
);

for (const operation of ['BEGIN', 'select', 'update', 'delete', 'insert']) {
  it.effect(`keeps ${operation} SQL failures in the declared failure channel`, () =>
    Effect.scoped(
      Effect.gen(function* expectedBodyFailure() {
        const sqlError = failure(operation);
        const statements: string[] = [];
        const store = yield* makeFixture((statement) => {
          statements.push(statement);
          return statement.startsWith(operation) ? Effect.fail(sqlError) : Effect.succeed(rowsFor(statement));
        });
        const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
          expect(Schema.is(CommercePortalAuthRecoveryUnavailable)(error)).toBe(true);
          expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false);
        }
        expect(statements.includes('COMMIT')).toBe(false);
        expect(statements.includes('ROLLBACK')).toBe(operation !== 'BEGIN');
      }),
    ),
  );
}

it.effect('retains body and failed ROLLBACK diagnostics without making them enumerable', () =>
  Effect.scoped(
    Effect.gen(function* rollbackFailure() {
      const bodyError = failure('audit');
      const rollbackError = failure('ROLLBACK');
      const store = yield* makeFixture((statement) => {
        if (statement.startsWith('insert')) {
          return Effect.fail(bodyError);
        }
        if (statement === 'ROLLBACK') {
          return Effect.fail(rollbackError);
        }
        return Effect.succeed(rowsFor(statement));
      });
      const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
        const unavailableErrors = errors.filter(Schema.is(CommercePortalAuthRecoveryUnavailable));
        expect(unavailableErrors.length).toBeGreaterThan(0);
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false);
        const settlement = unavailableErrors.find(
          (error) => Object.getOwnPropertyDescriptor(error, 'cause')?.value?.settlementCause !== undefined,
        );
        expect(settlement).toBeDefined();
        const descriptor = Object.getOwnPropertyDescriptor(settlement, 'cause');
        expect(descriptor?.enumerable).toBe(false);
        expect(Option.isSome(descriptor?.value.bodyExit)).toBe(true);
        expect(Exit.isFailure(descriptor?.value.bodyExit.value)).toBe(true);
        expect(
          descriptor?.value.settlementCause.reasons.some(
            (reason: Cause.Reason<unknown>) => Cause.isDieReason(reason) && reason.defect === rollbackError,
          ),
        ).toBe(true);
        expect(JSON.stringify(settlement)).not.toContain('Fixture transport unavailable');
      }
    }),
  ),
);

for (const rollbackFails of [false, true]) {
  it.effect(`preserves unrelated body defects when rollback ${rollbackFails ? 'fails' : 'succeeds'}`, () =>
    Effect.scoped(
      Effect.gen(function* preserveBodyDefect() {
        const defect = new Error('Fixture programming defect');
        const store = yield* makeFixture((statement) => {
          if (statement.startsWith('update')) {
            return Effect.die(defect);
          }
          if (statement === 'ROLLBACK' && rollbackFails) {
            return Effect.fail(failure('ROLLBACK'));
          }
          return Effect.succeed(rowsFor(statement));
        });
        const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
          expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
        }
      }),
    ),
  );
  it.effect(`preserves body interruption when rollback ${rollbackFails ? 'fails' : 'succeeds'}`, () =>
    Effect.scoped(
      Effect.gen(function* preserveBodyInterruption() {
        const store = yield* makeFixture((statement) => {
          if (statement.startsWith('update')) {
            return Effect.interrupt;
          }
          if (statement === 'ROLLBACK' && rollbackFails) {
            return Effect.fail(failure('ROLLBACK'));
          }
          return Effect.succeed(rowsFor(statement));
        });
        const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
          expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
        }
      }),
    ),
  );
}

it.effect('does not translate an unrelated COMMIT defect', () =>
  Effect.scoped(
    Effect.gen(function* preserveSettlementDefect() {
      const defect = new Error('Fixture COMMIT programming defect');
      const store = yield* makeFixture((statement) =>
        statement === 'COMMIT' ? Effect.die(defect) : Effect.succeed(rowsFor(statement)),
      );
      const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
      }
    }),
  ),
);

for (const refused of [
  { deletes: 0, name: 'absent token', rows: [] },
  { deletes: 1, name: 'expired token', rows: [{ ...ledger, expires_at: '2026-10-18T00:00:00Z' }] },
  { deletes: 1, name: 'malformed binding', rows: [{ ...ledger, value: 'invalid-fixture-binding' }] },
  { deletes: 1, name: 'ambiguous binding', rows: [ledger, { ...ledger, id: 'second-ledger-fixture' }] },
]) {
  it.effect(`refuses ${refused.name} without verification or completion writes`, () =>
    Effect.scoped(
      Effect.gen(function* refusedVerification() {
        const statements: string[] = [];
        const store = yield* makeFixture((statement) => {
          statements.push(statement);
          return Effect.succeed(statement.startsWith('select') ? refused.rows : []);
        });
        expect(yield* store.consumeEmailVerificationWithAudit(input)).toEqual(Option.none());
        expect(statements.filter((statement) => statement.startsWith('delete'))).toHaveLength(refused.deletes);
        expect(statements.some((statement) => statement.startsWith('update'))).toBe(false);
        expect(statements.some((statement) => statement.startsWith('insert'))).toBe(false);
      }),
    ),
  );
}

it.effect('requires the exact issuance subject, email and unverified state before consuming the ledger', () =>
  Effect.scoped(
    Effect.gen(function* changedBinding() {
      const statements: string[] = [];
      let updateParameters: readonly unknown[] = [];
      const store = yield* makeFixture((statement, parameters) => {
        statements.push(statement);
        if (statement.startsWith('update')) {
          updateParameters = parameters;
          return Effect.succeed([]);
        }
        return Effect.succeed(rowsFor(statement));
      });
      expect(yield* store.consumeEmailVerificationWithAudit(input)).toEqual(Option.none());
      expect(updateParameters).toContain('subject');
      expect(updateParameters).toContain('person@example.test');
      expect(updateParameters).toContain(false);
      expect(statements.some((statement) => statement.startsWith('delete'))).toBe(false);
      expect(statements.some((statement) => statement.startsWith('insert'))).toBe(false);
    }),
  ),
);

for (const rollbackFails of [false, true]) {
  it.effect(`preserves a body SqlError defect when rollback ${rollbackFails ? 'fails' : 'succeeds'}`, () =>
    Effect.scoped(
      Effect.gen(function* preserveBodySqlDefect() {
        const defect = failure('body-programming-defect');
        const store = yield* makeFixture((statement) => {
          if (statement.startsWith('update')) {
            return Effect.die(defect);
          }
          if (statement === 'ROLLBACK' && rollbackFails) {
            return Effect.fail(failure('ROLLBACK'));
          }
          return Effect.succeed(rowsFor(statement));
        });
        const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
          expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
          expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
        }
      }),
    ),
  );
}

it.effect('keeps a typed body failure internally when unexpected ROLLBACK dominates it', () =>
  Effect.scoped(
    Effect.gen(function* compoundBodyAndRollback() {
      const bodyError = failure('audit');
      const rollbackDefect = new Error('Fixture ROLLBACK programming defect');
      const store = yield* makeFixture((statement) => {
        if (statement.startsWith('insert')) {
          return Effect.fail(bodyError);
        }
        if (statement === 'ROLLBACK') {
          return Effect.die(rollbackDefect);
        }
        return Effect.succeed(rowsFor(statement));
      });
      const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === rollbackDefect)).toBe(
          true,
        );
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
        const redacted = Context.getOrUndefined(Cause.annotations(exit.cause), diagnosticKey);
        expect(Redacted.isRedacted(redacted)).toBe(true);
        if (redacted !== undefined) {
          const diagnostic = Redacted.value(redacted);
          expect(diagnostic.originalCause.reasons.some(Cause.isFailReason)).toBe(true);
          expect(Option.isSome(diagnostic.bodyExit) && Exit.isFailure(diagnostic.bodyExit.value)).toBe(true);
          expect(
            diagnostic.settlementCause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === rollbackDefect,
            ),
          ).toBe(true);
          expect(JSON.stringify(redacted).includes('Fixture')).toBe(false);
        }
      }
    }),
  ),
);

it.effect('keeps typed diagnostics when connection release interrupts after a successful ROLLBACK', () =>
  Effect.scoped(
    Effect.gen(function* compoundBodyAndReleaseInterrupt() {
      const statements: string[] = [];
      const store = yield* makeFixture((statement) => {
        statements.push(statement);
        return statement.startsWith('insert') ? Effect.fail(failure('audit')) : Effect.succeed(rowsFor(statement));
      }, Effect.interrupt);
      const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
      expect(statements).toContain('ROLLBACK');
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
        expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(false);
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
        const redacted = Context.getOrUndefined(Cause.annotations(exit.cause), diagnosticKey);
        expect(Redacted.isRedacted(redacted)).toBe(true);
        if (redacted !== undefined) {
          const diagnostic = Redacted.value(redacted);
          expect(diagnostic.originalCause.reasons.some(Cause.isFailReason)).toBe(true);
          expect(diagnostic.originalCause.reasons.some(Cause.isInterruptReason)).toBe(true);
          expect(diagnostic.originalCause.reasons.some(Cause.isDieReason)).toBe(false);
        }
      }
    }),
  ),
);

it.effect('preserves original defect identity and prior annotations under unexpected dominance', () =>
  Effect.scoped(
    Effect.gen(function* preservePriorMetadata() {
      const defect = new Error('Fixture annotated body defect');
      const bodyCause = Cause.annotate(Cause.die(defect), Context.make(priorAnnotation, 'preserved'));
      const store = yield* makeFixture((statement) => {
        if (statement.startsWith('update')) {
          return Effect.failCause(bodyCause);
        }
        if (statement === 'ROLLBACK') {
          return Effect.fail(failure('ROLLBACK'));
        }
        return Effect.succeed(rowsFor(statement));
      });
      const exit = yield* store.consumeEmailVerificationWithAudit(input).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
        expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false);
        expect(Context.getOrUndefined(Cause.annotations(exit.cause), priorAnnotation)).toBe('preserved');
      }
    }),
  ),
);
