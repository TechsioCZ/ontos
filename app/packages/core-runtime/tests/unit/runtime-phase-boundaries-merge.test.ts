import { NodeCrypto } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Cause, DateTime, Effect, Exit, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { tenants } from '../../src/db/schema.ts';
import { OpenDatabaseTransaction, refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type {
  ReadFinishContext,
  ReadHandlerContext,
  ReadLoadContext,
  ReadPrepareContext,
} from '../../src/reads/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadServiceFactory } from '../../src/reads/definition.ts';
import { ReadHandlerUnavailable } from '../../src/reads/errors.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { fixtureActionAccess } from '../support/access-declaration-fixtures.ts';

/**
 * The merged runtime must keep the demo's three-phase owner work (prepare outside, load inside the
 * read's own scoped transaction, finish after commit) while the main runtime's transaction IO guard
 * fires inside those transactions and the gate's own row and field answers reach the owner. These
 * cases pin each boundary; they never assert on authorization metadata.
 */

const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:phase-boundaries',
    authMethod: 'session',
    principalId: '40000000-0000-4000-8000-000000000002',
    tenantId: '40000000-0000-4000-8000-000000000003',
  }),
  correlationId: 'phase-boundaries',
};
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00.000Z'));
const phases: string[] = [];
let actionPreparations = 0;

/** Tests narrow opaque causes here; no unparsed cause escapes this assertion seam. */
const diedWithIoGuard = <Value, Failure>(exit: Exit.Exit<Value, Failure>): boolean => {
  if (Exit.isSuccess(exit)) {
    return false;
  }
  const reason = exit.cause.reasons.find(Cause.isDieReason);
  return reason !== undefined && Predicate.isTagged(reason.defect, 'IoInsideDatabaseTransaction');
};
const failedWithHandlerExecution = <Value, Failure>(exit: Exit.Exit<Value, Failure>): boolean => {
  if (Exit.isSuccess(exit)) {
    return false;
  }
  const reason = exit.cause.reasons.find(Cause.isFailReason);
  return reason !== undefined && Predicate.isTagged(reason.error, 'ActionHandlerExecutionError');
};

const phaseReadInput = Schema.Struct({});
type PhaseReadInput = Schema.Schema.Type<typeof phaseReadInput>;

interface PhaseReadServices {
  readonly rows: Effect.Effect<readonly string[], ReadHandlerUnavailable>;
}
interface PreparedPhase {
  readonly marker: 'prepared';
}
interface LoadedPhase {
  readonly marker: 'loaded';
  readonly rows: readonly string[];
}

const ownerRows = (transaction: Pick<ScopedTransactionExecutor, 'select'>) =>
  transaction
    .select({ tenantId: tenants.tenantId })
    .from(tenants)
    .where(sql`${tenants.createdAt} <= transaction_timestamp()`)
    .pipe(
      Effect.map((rows) => rows.map((row) => row.tenantId)),
      Effect.mapError(
        () => new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner unavailable' }),
      ),
    );

const ownerServices: ReadServiceFactory<PhaseReadServices> = (transaction) =>
  Effect.succeed({ rows: ownerRows(transaction) });

/**
 * A read or Action whose descriptor declares no genuine Core identity still runs under a bound owner
 * (O62): without one, Core cannot prove the receiving deployment admits the operation and fails closed
 * before any owner work. The fixture owner names this module and declares no intrinsic requirements.
 */
const phaseOwnerRegistration = makeTestOperationOwner({ moduleId: 'test.phase-boundaries' }).ownerRegistration;

/**
 * A staged list read: `prepare` runs before the transaction, `load` inside the read's own scoped
 * transaction, and `finish` after commit with its own short `context.transaction`.
 */
const stagedRead = defineRead(
  {
    accessDeclaration: {
      key: 'test.phase-boundaries.phase.list',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'inventory', level: 'basic' },
      risk: 'routine',
      selectors: ['all'],
    },
    accessKind: 'list',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'test.phase-boundaries.list',
      moduleKey: 'test.phase-boundaries',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.phase-boundaries.list.evidence' },
    inputSchema: phaseReadInput,
    legalEntityScope: 'forbidden',
    owningModuleKey: 'test.phase-boundaries',
    policies: [],
    readKey: 'test.phase-boundaries.list',
    resultSchema: Schema.Array(Schema.String),
    schemaVersion: '1',
  },
  {
    // oxlint-disable perfectionist/sort-objects -- Owner steps stay in execution order; each step's types infer from the previous one.
    prepare: Effect.fn('PhaseBoundaries.prepare')(function* preparePhase(
      _input: PhaseReadInput,
      _context: ReadPrepareContext,
    ) {
      // Owner `prepare` is remote work: no database transaction is open on this fiber yet.
      expect(Option.isNone(yield* OpenDatabaseTransaction)).toBe(true);
      yield* refuseInsideDatabaseTransaction('spicedb', 'phase-boundaries.prepare');
      phases.push('prepare');
      return { marker: 'prepared' } as const;
    }),
    load: Effect.fn('PhaseBoundaries.load')(function* loadPhase(
      _input: PhaseReadInput,
      context: ReadLoadContext<PhaseReadServices, PreparedPhase>,
    ) {
      // Owner `load` runs inside the read's own scoped transaction, so remote IO is refused here.
      expect(Option.isSome(yield* OpenDatabaseTransaction)).toBe(true);
      // The gate's own row filter and denied field paths reach the owner step (O17, O25).
      expect(context.listAccess).toEqual({ groups: [] });
      expect(Array.isArray(context.deniedFieldPaths)).toBe(true);
      phases.push('load');
      const rows = yield* context.services.rows;
      return { marker: 'loaded', rows } as const;
    }),
    finish: Effect.fn('PhaseBoundaries.finish')(function* finishPhase(
      _input: PhaseReadInput,
      context: ReadFinishContext<PreparedPhase, LoadedPhase>,
    ) {
      // Owner `finish` runs after the read transaction committed: the connection is back in the pool.
      expect(Option.isNone(yield* OpenDatabaseTransaction)).toBe(true);
      yield* refuseInsideDatabaseTransaction('spicedb', 'phase-boundaries.finish');
      phases.push('finish');
      // A `finish` that must read owner state opens its own short transaction, guarded like the read's.
      const observed = yield* context.transaction((transaction) =>
        Effect.gen(function* finishOwnerState() {
          expect(Option.isSome(yield* OpenDatabaseTransaction)).toBe(true);
          const refused = yield* Effect.exit(
            refuseInsideDatabaseTransaction('outbound-fetch', 'phase-boundaries.finish-transaction'),
          );
          expect(diedWithIoGuard(refused)).toBe(true);
          return yield* ownerRows(transaction);
        }),
      );
      expect(observed).toEqual(context.loaded.rows);
      return { evidence: { resultCount: context.loaded.rows.length }, result: context.loaded.rows };
    }),
    // oxlint-enable perfectionist/sort-objects
  },
  ownerServices,
);

/** A single-step read whose owner work reaches remote IO inside the governed read transaction. */
const refusingRead = defineRead(
  {
    accessDeclaration: {
      key: 'test.phase-boundaries.phase.refuse',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'inventory', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'test.phase-boundaries.refusing',
      moduleKey: 'test.phase-boundaries',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.phase-boundaries.refusing.evidence' },
    inputSchema: phaseReadInput,
    legalEntityScope: 'forbidden',
    owningModuleKey: 'test.phase-boundaries',
    policies: [],
    readKey: 'test.phase-boundaries.refusing',
    resultSchema: Schema.Array(Schema.String),
    schemaVersion: '1',
  },
  (_input: PhaseReadInput, context: ReadHandlerContext<PhaseReadServices>) =>
    refuseInsideDatabaseTransaction('outbound-fetch', 'phase-boundaries.refusing-handler').pipe(
      Effect.andThen(context.services.rows),
      Effect.map((rows) => ({ evidence: { resultCount: rows.length }, result: rows })),
    ),
  ownerServices,
);

const actionPrincipal = {
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:phase-boundaries-action',
  authMethod: 'session',
  principalId: '50000000-0000-4000-8000-000000000002',
  tenantId: '50000000-0000-4000-8000-000000000003',
} as const;

/** One Action descriptor, reused by the staged-preparation and the guarded-handler cases. */
const phaseAction = defineAction(
  {
    accessDeclaration: fixtureActionAccess('test.phase-boundaries'),
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.phase-boundaries.action.evidence.v1' },
    actionKey: 'test.phase-boundaries.prepare',
    auditProfile: 'minimal',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: 'test.phase-boundaries.prepare',
      moduleKey: 'test.phase-boundaries',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'test.phase-boundaries',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    policies: [],
    resultSchema: Schema.Struct({ total: Schema.Finite }),
    schemaVersion: '1',
  },
  (_payload, _context) => Effect.succeed({ total: 2 }),
);

/** The owner's staged preparation: remote work outside, its own guarded snapshot transaction. */
const preparedAction = defineAction(
  phaseAction.descriptor,
  (_payload, context) => Effect.succeed({ total: context.services.total }),
  (): Effect.Effect<{ readonly total: number }> => Effect.die('The prepared factory must replace ordinary acquisition'),
  {
    prepareServices: Effect.fn('PhaseBoundaries.prepareServices')(function* prepareOwnerServices(payload, context) {
      // The staged preparation itself is outside any transaction, so remote grants are legal here.
      expect(Option.isNone(yield* OpenDatabaseTransaction)).toBe(true);
      yield* refuseInsideDatabaseTransaction('spicedb', 'phase-boundaries.prepare-services');
      const snapshot = yield* context.transaction(() =>
        Effect.gen(function* prepareOwnerSnapshot() {
          // The owner snapshot opens its own short, guarded transaction.
          expect(Option.isSome(yield* OpenDatabaseTransaction)).toBe(true);
          const refused = yield* Effect.exit(
            refuseInsideDatabaseTransaction('outbound-fetch', 'phase-boundaries.prepare-services-transaction'),
          );
          expect(diedWithIoGuard(refused)).toBe(true);
          return payload.amount;
        }),
      );
      actionPreparations += 1;
      return () => Effect.succeed({ total: snapshot + 1 });
    }),
  },
);

/** An Action whose handler reaches remote IO inside the owner's governed write transaction. */
const guardedAction = defineAction(phaseAction.descriptor, (_payload, _context) =>
  refuseInsideDatabaseTransaction('outbound-fetch', 'phase-boundaries.action-handler').pipe(
    Effect.andThen(Effect.succeed({ total: 2 })),
  ),
);

it.layer(NodeCrypto.layer)('runtime phase boundaries (merged main and demo)', (suite) => {
  suite.effect('passes a natively admitted revision to every owner step without holding a pooled transaction', () =>
    Effect.gen(function* nativeAdmittedReadPhases() {
      let expectedRevision = '';
      const nativePhases: string[] = [];
      const nativeRead = defineRead(
        stagedRead.descriptor,
        {
          // oxlint-disable perfectionist/sort-objects -- Owner nativePhases follow execution order.
          prepare: (_input, context: ReadPrepareContext) =>
            Effect.gen(function* nativePrepare() {
              expect(context.compositionRevision).toBe(expectedRevision);
              expect(Option.isNone(yield* OpenDatabaseTransaction)).toBe(true);
              yield* refuseInsideDatabaseTransaction('spicedb', 'native-admitted.prepare');
              nativePhases.push('prepare');
              return { marker: 'prepared' } as const;
            }),
          load: (_input, context: ReadLoadContext<PhaseReadServices, PreparedPhase>) =>
            Effect.gen(function* nativeLoad() {
              expect(context.compositionRevision).toBe(expectedRevision);
              expect(Option.isSome(yield* OpenDatabaseTransaction)).toBe(true);
              nativePhases.push('load');
              return yield* context.services.rows;
            }),
          finish: (_input, context: ReadFinishContext<PreparedPhase, readonly string[]>) =>
            Effect.gen(function* nativeFinish() {
              expect(context.compositionRevision).toBe(expectedRevision);
              expect(Option.isNone(yield* OpenDatabaseTransaction)).toBe(true);
              yield* refuseInsideDatabaseTransaction('spicedb', 'native-admitted.finish');
              nativePhases.push('finish');
              const observed = yield* context.transaction(ownerRows);
              expect(observed).toEqual(context.loaded);
              return { evidence: { resultCount: observed.length }, result: observed };
            }),
          // oxlint-enable perfectionist/sort-objects
        },
        ownerServices,
      );
      const owner = makeTestOperationOwner({ moduleId: 'test.phase-boundaries', reads: [nativeRead] });
      expectedRevision = (yield* owner.snapshot).composition.revision;
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        applicationComposition: owner.applicationComposition,
        compositionRevision: expectedRevision,
        executeOwnerQuery: () => Effect.succeed([{ tenantId: scope.tenantId }]),
        expectedDeployment: owner.expectedDeployment,
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: owner.ownerRegistration,
        scope,
      });
      expect(
        yield* harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: nativeRead,
          transport: { correlationId: scope.correlationId },
        }),
      ).toEqual([scope.tenantId]);
      expect(nativePhases).toEqual(['prepare', 'load', 'finish']);
      const { statements } = harness.snapshot();
      const evidenceIndex = statements.findIndex((statement) => statement.includes('data_access_events'));
      expect(statements.slice(0, evidenceIndex).filter((statement) => statement === 'COMMIT')).toHaveLength(2);
      expect(statements.slice(0, evidenceIndex)).not.toContainEqual(expect.stringMatching(/^SAVEPOINT/u));
      expect(statements.at(-1)).toBe('COMMIT');
    }),
  );

  suite.effect('runs owner prepare outside, load inside the scoped transaction, and finish after commit', () =>
    Effect.gen(function* stagedReadPhases() {
      phases.length = 0;
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.succeed([{ tenantId: scope.tenantId }]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: phaseOwnerRegistration,
        scope,
      });
      const invocation = {
        input: {},
        principal: scope,
        registration: stagedRead,
        transport: { correlationId: scope.correlationId },
      };
      expect(yield* harness.runtime.runRead(invocation)).toEqual([scope.tenantId]);
      // The three owner steps ran in phase order around one read transaction.
      expect(phases).toEqual(['prepare', 'load', 'finish']);
      const snapshot = harness.snapshot();
      expect(snapshot.stages).toContain('scope_installed');
      expect(snapshot.stages.slice(-3)).toEqual(['handler_executed', 'result_decoded', 'evidence_persisted']);
      expect(snapshot.evidenceWrites).toBe(1);
      // Allowed evidence runs in its own scoped transaction after the read transaction commits.
      const ownerCommitIndex = snapshot.statements.indexOf('COMMIT');
      const evidenceIndex = snapshot.statements.findIndex((statement) => statement.includes('data_access_events'));
      expect(ownerCommitIndex).toBeGreaterThan(-1);
      expect(evidenceIndex).toBeGreaterThan(ownerCommitIndex);
    }),
  );

  suite.effect('refuses remote IO inside the governed read transaction', () =>
    Effect.gen(function* refusesReadRemoteIo() {
      phases.length = 0;
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: () => Effect.succeed([{ tenantId: scope.tenantId }]),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: phaseOwnerRegistration,
        scope,
      });
      const exit = yield* Effect.exit(
        harness.runtime.runRead({
          input: {},
          principal: scope,
          registration: refusingRead,
          transport: { correlationId: scope.correlationId },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(diedWithIoGuard(exit)).toBe(true);
      expect(harness.snapshot().evidenceWrites).toBe(0);
    }),
  );

  suite.effect('executes owner prepareServices before the Action transaction and uses its factory', () =>
    Effect.gen(function* retainedActionPreflight() {
      actionPreparations = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        ownerRegistration: phaseOwnerRegistration,
        tenantPermission: 'allowed',
      });
      const result = yield* harness.runtime.runAction({
        payload: { amount: 2 },
        principal: actionPrincipal,
        registration: preparedAction,
        transport: { correlationId: 'phase-boundaries-prepared', idempotencyKey: 'phase-boundaries-prepared-once' },
      });
      expect(result).toEqual({ total: 3 });
      expect(actionPreparations).toBe(1);
      expect(harness.snapshot().committed.length).toBe(1);
    }),
  );

  suite.effect('refuses remote IO inside the governed Action transaction', () =>
    Effect.gen(function* refusesActionRemoteIo() {
      actionPreparations = 0;
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        ownerRegistration: phaseOwnerRegistration,
        tenantPermission: 'allowed',
      });
      const exit = yield* Effect.exit(
        harness.runtime.runAction({
          payload: { amount: 2 },
          principal: actionPrincipal,
          registration: guardedAction,
          transport: { correlationId: 'phase-boundaries-guarded', idempotencyKey: 'phase-boundaries-guarded-once' },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // The guard's die surfaces as the runtime's own handler-execution failure, so the owner write
      // never commits; the handler would have succeeded and committed without the guard.
      expect(failedWithHandlerExecution(exit)).toBe(true);
      expect(harness.snapshot().committed.length).toBe(0);
    }),
  );
});
