import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionDurableWorkDrained,
  loadDatabaseConnectionPair,
  publishApplicationCompositionAuthority,
  scopedRoutineInvokerFromTransaction,
} from '@app/core-runtime';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  EnrollmentLeaseTokenSchema,
  ReadEnrollmentAttemptInputSchema,
  RecordEnrollmentOutcomeInputSchema,
  StartEnrollmentAttemptInputSchema,
} from '../../shared/enrollment-contracts.ts';
import {
  admitEnrollmentAttempt,
  commerceEnrollmentAttemptPersistenceForTransaction,
} from '../../src/enrollment/attempts/attempt-persistence.ts';
import { installEnrollmentTestAuthority } from '../support/enrollment-composition-authority.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

type TestDatabase = Effect.Success<ReturnType<typeof makeTestDatabaseFromClient<typeof coreRelations>>>;
type Transaction = Parameters<Parameters<TestDatabase['transaction']>[0]>[0];
type Execute = Parameters<typeof scopedRoutineInvokerFromTransaction>[0];
const migrationName = '20261024013000_parked-enrollment-composition-admission';

const installParkedAdmission = (execute: Execute) =>
  Effect.gen(function* installNativeAdmission() {
    const columnRows = yield* execute(sql`select exists(select 1 from information_schema.columns
      where table_schema = 'commerce_customer_context' and table_name = 'portal_enrollment_attempts'
        and column_name = 'continuation_composition_revision') as installed`);
    const [column] = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ installed: Schema.Boolean })))(
      columnRows,
    );
    const migration = readFileSync(new URL(`../../drizzle/${migrationName}/migration.sql`, import.meta.url), 'utf-8');
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (column?.installed && statement.includes('ADD COLUMN continuation_composition_revision')) {
        continue;
      }
      yield* execute(sql.raw(statement.replaceAll('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ')));
    }
  });

const expectRefused = (execute: Execute, operation: Effect.Effect<unknown, unknown>) =>
  Effect.gen(function* assertNativeRefusal() {
    yield* execute(sql`savepoint expected_refusal`);
    const answer = yield* operation.pipe(Effect.result);
    yield* execute(sql`rollback to savepoint expected_refusal`);
    expect(Result.isFailure(answer)).toBe(true);
  });

const parkedJourney = (transaction: Transaction, revisionA: string, revisionB: string) =>
  Effect.gen(function* parkedJourneyAcceptance() {
    const execute: Execute = (statement) => transaction.execute(statement, 'objects');
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const scope = { tenantId };
    yield* execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`);
    // The fixture starts with the formerly published trigger, proving that the correcting
    // migration accounts for an existing wait instead of requiring signup to be replayed.
    const terminal = readFileSync(
      new URL('../../drizzle/20261024001000_enrollment-terminal-failure/migration.sql', import.meta.url),
      'utf-8',
    );
    const guard = terminal.slice(
      terminal.indexOf('CREATE OR REPLACE FUNCTION'),
      terminal.indexOf('--> statement-breakpoint', terminal.indexOf('CREATE OR REPLACE FUNCTION')),
    );
    yield* execute(sql.raw(guard));
    const invoker = scopedRoutineInvokerFromTransaction(execute, scope);
    const persistence = commerceEnrollmentAttemptPersistenceForTransaction(invoker, scope);
    const input = yield* Schema.decodeEffect(StartEnrollmentAttemptInputSchema)({
      actionInvocationId: randomUUID(),
      actorPrincipalId: actorId,
      compositionRevision: revisionA,
      intentDigest: 'a'.repeat(64),
      intentKey: `parked:${randomUUID()}`,
      journey: 'RETAIL_SELF_ENROLLMENT',
      tenantId,
    });
    const started = yield* persistence.create(input);
    const identity = yield* Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
      portalEnrollmentAttemptId: started.attempt.portalEnrollmentAttemptId,
      tenantId,
    });
    const claim = yield* Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
      ...identity,
      actorPrincipalId: actorId,
      expectedRevision: started.attempt.revision,
      leaseDurationMs: 30_000,
      ownerInvocationId: randomUUID(),
      ownerModuleKey: 'commerce.customer-context',
      requestDigest: 'b'.repeat(64),
      required: true,
      transitionKey: 'provider.account.create',
      workerId: 'parked-fixture',
    });
    const claimed = yield* persistence.claim(claim);
    const record = yield* Schema.decodeEffect(RecordEnrollmentOutcomeInputSchema)({
      ...identity,
      accountSubject: {
        authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
        providerSubjectId: randomUUID(),
        subjectType: 'user',
      },
      actorPrincipalId: actorId,
      expectedRevision: claimed.attempt.revision,
      leaseToken: yield* Schema.decodeUnknownEffect(EnrollmentLeaseTokenSchema)(claimed.attempt.lease?.leaseToken),
      ownerInvocationId: claim.ownerInvocationId,
      ownerModuleKey: claim.ownerModuleKey,
      resultReference: 'real-provider-fixture-result',
      status: 'SUCCEEDED',
      transitionKey: claim.transitionKey,
      workerId: claim.workerId,
    });
    const parked = yield* persistence.record(record, 'VERIFICATION_REQUIRED');
    yield* execute(
      sql`update commerce_customer_context.portal_enrollment_attempts set sweep_count = 7, sweep_revision = revision where portal_enrollment_attempt_id = ${identity.portalEnrollmentAttemptId}::uuid`,
    );
    const oldMarker = `enrollment-attempt:${tenantId}:${identity.portalEnrollmentAttemptId}`;
    const beforeRows = yield* execute(
      sql`select exists(select 1 from core.application_composition_durable_work where work_id = ${oldMarker}) as blocked`,
    );
    const [before] = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ blocked: Schema.Boolean })))(
      beforeRows,
    );
    expect(before?.blocked).toBe(true);
    yield* installParkedAdmission(execute);
    yield* closeApplicationCompositionDurableAdmission(transaction, revisionA);
    expect(yield* isApplicationCompositionDurableWorkDrained(transaction, revisionA)).toBe(true);
    yield* drainApplicationCompositionAuthority(transaction, revisionA);
    return { actorId, claim, execute, identity, invoker, parked, persistence, record, revisionA, revisionB, tenantId };
  });

type ParkedFixture = Effect.Success<ReturnType<typeof parkedJourney>>;

const resumeUnderCurrentRelease = (fixture: ParkedFixture) =>
  Effect.gen(function* readmitsParkedJourney() {
    const { execute, identity, invoker, parked, persistence, revisionA, revisionB } = fixture;
    yield* execute(sql`set local role ontos_runtime`);
    yield* expectRefused(execute, admitEnrollmentAttempt(invoker, identity, revisionA));
    yield* admitEnrollmentAttempt(invoker, identity, revisionB);
    const resumed = yield* persistence.read(identity);
    expect(resumed.compositionRevision).toBe(revisionB);
    expect(resumed.revision).toBe(parked.attempt.revision);
    expect(resumed.accountSubject).toStrictEqual(parked.attempt.accountSubject);
    yield* execute(sql`reset role`);
    const [origin] = yield* execute(sql`select composition_revision, continuation_composition_revision, sweep_count
      from commerce_customer_context.portal_enrollment_attempts where tenant_id = ${identity.tenantId}::uuid
        and portal_enrollment_attempt_id = ${identity.portalEnrollmentAttemptId}::uuid`);
    expect(origin).toMatchObject({
      composition_revision: revisionA,
      continuation_composition_revision: revisionB,
      sweep_count: 7,
    });
    const operation = yield* persistence.readOperation({
      ...identity,
      ownerModuleKey: fixture.claim.ownerModuleKey,
      transitionKey: fixture.claim.transitionKey,
    });
    expect(operation.ownerInvocationId).toBe(fixture.claim.ownerInvocationId);
    expect(operation.status).toBe('SUCCEEDED');
    yield* execute(sql`set local role ontos_runtime`);
    yield* expectRefused(
      execute,
      execute(
        sql`select * from commerce_customer_context.admit_portal_enrollment_attempt(${randomUUID()}::uuid, ${identity.portalEnrollmentAttemptId}::uuid, ${revisionB})`,
      ),
    );
    yield* execute(sql`set local role ontos_runtime`);
    yield* execute(sql`select set_config('ontos.tenant_id', '', true)`);
    yield* expectRefused(
      execute,
      execute(sql`select commerce_customer_context.claim_portal_enrollment_sweep(
      ${identity.tenantId}::uuid, ${identity.portalEnrollmentAttemptId}::uuid, ${resumed.revision}, 7, 0, ${revisionA})`),
    );
    expect(
      yield* execute(sql`select commerce_customer_context.claim_portal_enrollment_sweep(
      ${identity.tenantId}::uuid, ${identity.portalEnrollmentAttemptId}::uuid, ${resumed.revision}, 7, 0, ${revisionB}) as count`),
    ).toEqual([{ count: null }]);
    yield* execute(sql`select set_config('ontos.tenant_id', ${identity.tenantId}, true)`);
    const claim = yield* Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
      ...fixture.claim,
      expectedRevision: resumed.revision,
      ownerInvocationId: randomUUID(),
      transitionKey: 'provider.account.verify',
    });
    const claimed = yield* persistence.claim(claim);
    yield* execute(sql`reset role`);
    return { ...fixture, claim, claimed };
  });

const unresolvedOwnersPinTheirRelease = (
  transaction: Transaction,
  fixture: Effect.Success<ReturnType<typeof resumeUnderCurrentRelease>>,
) =>
  Effect.gen(function* preservesUnresolvedOwnerFences() {
    const { claim, execute, identity, revisionB } = fixture;
    const marker = `enrollment-operation:${identity.tenantId}:${identity.portalEnrollmentAttemptId}:${claim.ownerInvocationId}`;
    const trackedRows = yield* execute(
      sql`select original_revision from core.application_composition_durable_work where work_id = ${marker}`,
    );
    const [tracked] = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ original_revision: Schema.String })),
    )(trackedRows);
    expect(tracked?.original_revision).toBe(revisionB);
    yield* closeApplicationCompositionDurableAdmission(transaction, revisionB);
    expect(yield* isApplicationCompositionDurableWorkDrained(transaction, revisionB)).toBe(false);
    yield* expectRefused(execute, drainApplicationCompositionAuthority(transaction, revisionB));
    yield* expectRefused(
      execute,
      execute(sql`update commerce_customer_context.portal_enrollment_owner_operations
      set owner_invocation_id = ${randomUUID()}::uuid where owner_invocation_id = ${claim.ownerInvocationId}::uuid`),
    );
    yield* execute(sql`update commerce_customer_context.portal_enrollment_owner_operations
      set lease_expires_at = clock_timestamp() - interval '1 second'
      where owner_invocation_id = ${claim.ownerInvocationId}::uuid`);
    expect(yield* isApplicationCompositionDurableWorkDrained(transaction, revisionB)).toBe(false);
    yield* execute(sql`set local role ontos_runtime`);
    yield* expectRefused(execute, admitEnrollmentAttempt(fixture.invoker, identity, revisionB));
    yield* execute(sql`reset role`);
    yield* execute(sql`savepoint unresolved_release_probe`);
    const forcedRevision = 'c'.repeat(64);
    yield* execute(
      sql`update core.application_composition_authority set revision = ${forcedRevision}, durable_work_admission = 'open' where authority_key = 'active'`,
    );
    yield* execute(sql`set local role ontos_runtime`);
    yield* expectRefused(execute, admitEnrollmentAttempt(fixture.invoker, identity, forcedRevision));
    yield* execute(sql`rollback to savepoint unresolved_release_probe`);
    // An expired worker is not proof of an owner outcome. Every unresolved native status retains
    // the exact original marker, and a new owner invocation cannot sneak through closed admission.
    for (const status of ['IN_PROGRESS', 'INDETERMINATE', 'RECONCILIATION_REQUIRED', 'FAILED']) {
      yield* execute(sql`update commerce_customer_context.portal_enrollment_owner_operations
        set status = ${status}, completed_at = case when ${status} = 'IN_PROGRESS' then null else clock_timestamp() end, failure_code = case when ${status} = 'FAILED' then 'owner_reconciliation_required' else null end,
          lease_owner = null, lease_token = null, lease_expires_at = null
        where owner_invocation_id = ${claim.ownerInvocationId}::uuid`);
      expect(yield* isApplicationCompositionDurableWorkDrained(transaction, revisionB)).toBe(false);
    }
    yield* expectRefused(
      execute,
      execute(sql`insert into commerce_customer_context.portal_enrollment_owner_operations
      (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id, actor_principal_id, request_digest, status)
      values (${identity.tenantId}::uuid, ${identity.portalEnrollmentAttemptId}::uuid, 'commerce.customer-context', 'new.closed.operation', ${randomUUID()}::uuid, ${fixture.actorId}::uuid, ${'c'.repeat(64)}, 'IN_PROGRESS')`),
    );
    // Only an authoritative final answer clears the publication fence; the parked Attempt stays.
    yield* execute(sql`update commerce_customer_context.portal_enrollment_owner_operations
      set status = 'SUCCEEDED', failure_code = null, completed_at = clock_timestamp()
      where owner_invocation_id = ${claim.ownerInvocationId}::uuid`);
    expect(yield* isApplicationCompositionDurableWorkDrained(transaction, revisionB)).toBe(true);
  });

it.live(
  'publishes past a real human verification wait and re-admits its unchanged native journal under the new release',
  () =>
    Effect.scoped(
      Effect.gen(function* parkedCompositionAcceptance() {
        const releaseA = yield* makeEnrollmentApplicationCompositionSnapshot('parked-release-a', []);
        const releaseB = yield* makeEnrollmentApplicationCompositionSnapshot('parked-release-b', []);
        yield* installEnrollmentTestAuthority(releaseA.composition.revision);
        const connections = yield* loadDatabaseConnectionPair();
        const client = yield* makeTestPgClient(connections.admin.connectionString);
        const admin = yield* makeTestDatabaseFromClient(client, coreRelations);
        const rollback = new Error('parked composition acceptance rollback');
        yield* admin
          .transaction((transaction) =>
            Effect.gen(function* isolatedNativePublication() {
              const parked = yield* parkedJourney(
                transaction,
                releaseA.composition.revision,
                releaseB.composition.revision,
              );
              yield* publishApplicationCompositionAuthority(transaction, {
                ...releaseB,
                validUntil: DateTime.add(releaseB.validUntil, { hours: 2 }),
              });
              const resumed = yield* resumeUnderCurrentRelease(parked);
              yield* unresolvedOwnersPinTheirRelease(transaction, resumed);
              return yield* Effect.fail(rollback);
            }),
          )
          .pipe(
            Effect.catchIf(
              (failure) => failure === rollback,
              () => Effect.void,
            ),
          );
      }),
    ),
);
