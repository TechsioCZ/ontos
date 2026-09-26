import { findPostgresFailure, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import type {
  MarketAffectedUseAssessmentResponse,
  MarketRetirementInstantSchema,
  ReserveMarketRetirementPayload,
  ReserveMarketRetirementResult,
} from '@app/customer-market-retirement-contracts';
import { MarketAffectedUseSourceEvidenceSchema } from '@app/customer-market-retirement-contracts';
import { sql } from 'drizzle-orm';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { createHash } from 'node:crypto';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { makeMarketAffectedUseAssessmentServices } from '../../src/api/market-affected-use-assessment.read.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';
import {
  MarketRetirementReservationConflictError,
  marketAffectedUseAssessmentRepositoryForInvoker,
  marketRetirementReservationForTransaction,
} from '../../src/persistence/market-retirement-persistence.ts';
import { acquireOutlivingCleanup } from '../support/fixture-pg-client.ts';

const firstTenantId = 'e4100000-0000-4000-8000-000000000001';
const firstLegalEntityId = 'e4100000-0000-4000-8000-000000000002';
const firstMarketId = 'market-retirement-postgres-release';
const secondTenantId = 'e4200000-0000-4000-8000-000000000001';
const secondLegalEntityId = 'e4200000-0000-4000-8000-000000000002';
const secondMarketId = 'market-retirement-postgres-commit';
const thirdTenantId = 'e4400000-0000-4000-8000-000000000001';
const thirdLegalEntityId = 'e4400000-0000-4000-8000-000000000002';
const thirdMarketId = 'market-retirement-postgres-source-race';
const actorPrincipalId = 'e4300000-0000-4000-8000-000000000001';
const evaluatedAt = '2020-01-01T00:00:00.000Z';
const compositionValidUntil = '2099-01-01T00:00:00.000Z';
const compositionRevision = 'postgres-composition-1';

const actionInvocationIds = {
  commit: 'e4310000-0000-4000-8000-000000000006',
  commitRetry: 'e4310000-0000-4000-8000-000000000006',
  firstReserve: 'e4310000-0000-4000-8000-000000000001',
  freshReserve: 'e4310000-0000-4000-8000-000000000004',
  invalidDigest: 'e4310000-0000-4000-8000-000000000008',
  invalidExpiredProof: 'e4310000-0000-4000-8000-000000000009',
  invalidMissingProof: 'e4310000-0000-4000-8000-000000000010',
  invalidSubstitutedProof: 'e4310000-0000-4000-8000-000000000011',
  raceReserve: 'e4310000-0000-4000-8000-000000000012',
  release: 'e4310000-0000-4000-8000-000000000003',
  secondReserve: 'e4310000-0000-4000-8000-000000000002',
  terminalRelease: 'e4310000-0000-4000-8000-000000000007',
  versionProbe: 'e4310000-0000-4000-8000-000000000005',
} as const;

type CommerceCustomerContextTestDatabase = TestDatabaseFromClient<typeof commerceCustomerContextRelations>;
type ReservePayload = Extract<ReserveMarketRetirementPayload, { readonly operation: 'RESERVE' }>;
type FinishPayload<Operation extends 'COMMIT' | 'RELEASE'> = Extract<
  ReserveMarketRetirementPayload,
  { readonly operation: Operation }
>;

interface ReservationRow extends Record<string, unknown> {
  readonly assessment_digest: string;
  readonly lifecycle: 'COMMITTED' | 'RELEASED' | 'RESERVED';
  readonly market_resource_id: string;
  readonly market_revision: number;
  readonly reservation_version: number;
  readonly source_evidence: unknown;
}

interface RetirementRaceState extends Record<string, unknown> {
  readonly proposal_count: number;
  readonly reservation_count: number;
}

const proposalFixtures = {
  [firstTenantId]: {
    actionInvocationId: 'e4330000-0000-4000-8000-000000000002',
    canonicalHash: '1'.repeat(64),
    id: 'e4330000-0000-4000-8000-000000000001',
    resourceId: 'market-retirement-proposal-release',
  },
  [secondTenantId]: {
    actionInvocationId: 'e4330000-0000-4000-8000-000000000004',
    canonicalHash: '2'.repeat(64),
    id: 'e4330000-0000-4000-8000-000000000003',
    resourceId: 'market-retirement-proposal-commit',
  },
  [thirdTenantId]: {
    actionInvocationId: 'e4330000-0000-4000-8000-000000000006',
    canonicalHash: '3'.repeat(64),
    id: 'e4330000-0000-4000-8000-000000000005',
    resourceId: 'market-retirement-proposal-race',
  },
} as const;

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one Market retirement reservation row');
  }
  return row;
};

const inOwnerScope = <Value, Failure>(
  database: CommerceCustomerContextTestDatabase,
  tenantId: string,
  legalEntityId: string,
  operation: (transaction: CommerceCustomerContextTransaction) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* scopedOperation() {
      yield* transaction.execute(
        sql`select set_config('ontos.tenant_id', ${tenantId}, true),
                   set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
        'objects',
      );
      return yield* operation(transaction);
    }),
  );

const invokerFor = (transaction: CommerceCustomerContextTransaction, tenantId: string, legalEntityId: string) =>
  scopedRoutineInvokerFromTransaction((statement) => transaction.execute(statement, 'objects'), {
    legalEntityId,
    tenantId,
  });

const compositionEvidence = (
  moduleId: 'commerce.cart' | 'commerce.order',
  overrides: Readonly<{
    readonly sourceId?: string;
    readonly validUntil?: typeof MarketRetirementInstantSchema.Type;
  }> = {},
) =>
  Schema.decodeSync(MarketAffectedUseSourceEvidenceSchema)({
    completenessEvidence: {
      nextApplicabilityBoundary: overrides.validUntil ?? compositionValidUntil,
      observedAt: evaluatedAt,
      ownerRevision: compositionRevision,
      scope: {
        declaredScopeRef: `application-composition:${compositionRevision}`,
        kind: 'SAFELY_BROADER_SCOPE',
        predicateRef: `application-composition:module:${moduleId}:absent`,
      },
    },
    currentness: 'CURRENT',
    digest: createHash('sha256').update(`${compositionRevision}\0${moduleId}\0UNIMPLEMENTED`).digest('hex'),
    generation: compositionRevision,
    ownerRevision: compositionRevision,
    sourceId: overrides.sourceId ?? `application-composition:${moduleId}:UNIMPLEMENTED`,
  });

const compositionSourceEvidence = [compositionEvidence('commerce.cart'), compositionEvidence('commerce.order')];

const reserveInput = (
  assessment: Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }>,
): ReservePayload => ({
  assessmentDigest: assessment.assessmentDigest,
  evaluatedAt: assessment.evaluatedAt,
  marketRef: assessment.marketRef,
  marketRevision: assessment.marketRevision,
  operation: 'RESERVE',
  reason: 'PostgreSQL Market retirement reservation acceptance',
  sourceEvidence: assessment.sourceEvidence,
  tenantId: assessment.tenantId,
});

const assess = (
  database: CommerceCustomerContextTestDatabase,
  tenantId: string,
  legalEntityId: string,
  marketId: string,
  marketRevision: number,
) =>
  inOwnerScope(database, tenantId, legalEntityId, (transaction) => {
    const repository = marketAffectedUseAssessmentRepositoryForInvoker(
      invokerFor(transaction, tenantId, legalEntityId),
    );
    return makeMarketAffectedUseAssessmentServices(repository.assess, () =>
      Effect.succeed({ sourceEvidence: compositionSourceEvidence }),
    ).assess({
      evaluatedAt,
      marketRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: marketId,
        resourceType: 'commerce.market-catalog.market',
        tenantId,
      },
      marketRevision,
      tenantId,
    });
  }).pipe(
    Effect.flatMap((assessment) =>
      assessment.outcome === 'VERIFIED'
        ? Effect.succeed(assessment)
        : Effect.die(`Expected VERIFIED assessment, received ${assessment.outcome}`),
    ),
  );

const execute = (
  database: CommerceCustomerContextTestDatabase,
  tenantId: string,
  legalEntityId: string,
  payload: ReserveMarketRetirementPayload,
  actionInvocationId: string,
) =>
  inOwnerScope(database, tenantId, legalEntityId, (transaction) =>
    marketRetirementReservationForTransaction(invokerFor(transaction, tenantId, legalEntityId)).execute(payload, {
      actionInvocationId,
      actorPrincipalId,
    }),
  );

const finishInput = (operation: 'COMMIT', reservation: ReserveMarketRetirementResult): FinishPayload<'COMMIT'> => ({
  marketRef: reservation.marketRef,
  marketRevision: reservation.marketRevision,
  operation,
  reason: `PostgreSQL Market retirement ${operation.toLowerCase()} acceptance`,
  reservationToken: reservation.reservationToken,
  reservationVersion: reservation.reservationVersion,
  tenantId: reservation.tenantId,
});

const releaseInput = (reservation: ReserveMarketRetirementResult): FinishPayload<'RELEASE'> => ({
  marketRef: reservation.marketRef,
  marketRevision: reservation.marketRevision,
  operation: 'RELEASE',
  reason: 'PostgreSQL Market retirement release acceptance',
  reservationToken: reservation.reservationToken,
  reservationVersion: reservation.reservationVersion,
  tenantId: reservation.tenantId,
});

const isReservationConflict = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  Option.exists(Cause.findErrorOption(exit.cause), Schema.is(MarketRetirementReservationConflictError));

const isReferenceGuardConflict = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  Option.exists(
    findPostgresFailure(exit.cause),
    ({ code, constraint }) => code === '55P03' && constraint === 'market_retirement_reservation_conflict',
  );

const cleanupReservations = (admin: CommerceCustomerContextTestDatabase) => () =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanMarketRetirementFixtures() {
      yield* transaction.execute(
        sql`delete from commerce_customer_context.market_retirement_reservations
              where tenant_id in (${firstTenantId}::uuid, ${secondTenantId}::uuid, ${thirdTenantId}::uuid)`,
        'objects',
      );
      yield* transaction.execute(
        sql`delete from commerce_customer_context.purchase_proposal_revisions
              where tenant_id in (${firstTenantId}::uuid, ${secondTenantId}::uuid, ${thirdTenantId}::uuid)`,
        'objects',
      );
    }),
  );

const mutateBootstrapReference = (
  admin: CommerceCustomerContextTestDatabase,
  tenantId: string,
  legalEntityId: string,
  marketId: string,
  rollbackAfterInsert = false,
) =>
  inOwnerScope(admin, tenantId, legalEntityId, (transaction) => {
    const insert = transaction.execute(
      sql`insert into commerce_customer_context.market_bootstrap_policy_revisions (
            policy_revision_id, tenant_id, legal_entity_id, scope_kind,
            effective_from, applicable_from, lifecycle, idempotency_key, action_invocation_id,
            actor_principal_id, reason, default_channel_id,
            default_commerce_market_id, default_selling_legal_entity_id
          ) values (
            'e4320000-0000-4000-8000-000000000001'::uuid,
            ${tenantId}::uuid, ${legalEntityId}::uuid, 'SELLER',
            '2020-01-01T00:00:00.000Z'::timestamptz,
            '2020-01-01T00:00:00.000Z'::timestamptz, 'ACTIVE',
            'market-retirement-postgres-guard',
            'e4320000-0000-4000-8000-000000000002'::uuid,
            ${actorPrincipalId}::uuid, 'PostgreSQL Market retirement guard acceptance',
            'web', ${marketId}, ${legalEntityId}::uuid
          )`,
      'objects',
    );
    return rollbackAfterInsert
      ? Effect.gen(function* probeUnblockedInsert() {
          yield* transaction.execute(sql`savepoint market_retirement_guard_probe`, 'objects');
          yield* insert;
          yield* transaction.execute(sql`rollback to savepoint market_retirement_guard_probe`, 'objects');
        })
      : insert;
  });

const mutatePurchaseProposalReference = (
  admin: CommerceCustomerContextTestDatabase,
  tenantId: keyof typeof proposalFixtures,
  legalEntityId: string,
  marketId: string,
  rollbackAfterInsert = false,
) => {
  const fixture = proposalFixtures[tenantId];
  return inOwnerScope(admin, tenantId, legalEntityId, (transaction) => {
    const insert = transaction.execute(
      sql`insert into commerce_customer_context.purchase_proposal_revisions (
            purchase_proposal_revision_id, tenant_id, legal_entity_id,
            proposal_revision_resource_id, revision, proposal_sequence, buyer_principal_id,
            counterparty_resource_ref, profile_resource_ref, storefront_id, proposal_snapshot,
            source_revision_vector, canonicalization_version, canonical_hash, state,
            approval_evaluation, expires_at, idempotency_key, action_invocation_id, actor_principal_id,
            reason, recorded_at
          ) values (
            ${fixture.id}::uuid, ${tenantId}::uuid, ${legalEntityId}::uuid,
            ${fixture.resourceId}, 1, 1, ${actorPrincipalId}::uuid,
            'counterparty:market-retirement', 'profile:market-retirement', 'storefront-retirement',
            jsonb_build_object('context', jsonb_build_object('marketId', ${marketId}::text)),
            '[]'::jsonb, 'postgres-acceptance-v1', ${fixture.canonicalHash}, 'CURRENT',
            'WITHIN_LIMIT', '2099-01-01T00:00:00.000Z'::timestamptz,
            ${fixture.resourceId},
            ${fixture.actionInvocationId}::uuid, ${actorPrincipalId}::uuid,
            'PostgreSQL Market retirement proposal guard acceptance', statement_timestamp()
          )`,
      'objects',
    );
    return rollbackAfterInsert
      ? Effect.gen(function* probeUnblockedProposalInsert() {
          yield* transaction.execute(sql`savepoint market_retirement_proposal_guard_probe`, 'objects');
          yield* insert;
          yield* transaction.execute(sql`rollback to savepoint market_retirement_proposal_guard_probe`, 'objects');
        })
      : insert;
  });
};

const readRetirementRaceState = (
  admin: CommerceCustomerContextTestDatabase,
  tenantId: string,
  legalEntityId: string,
  marketId: string,
) =>
  admin.transaction((transaction) =>
    transaction
      .execute<RetirementRaceState>(
        sql`select
              (select count(*)::integer
                 from commerce_customer_context.market_retirement_reservations
                where tenant_id = ${tenantId}::uuid
                  and legal_entity_id = ${legalEntityId}::uuid
                  and market_resource_id = ${marketId}) as reservation_count,
              (select count(*)::integer
                 from commerce_customer_context.purchase_proposal_revisions
                where tenant_id = ${tenantId}::uuid
                  and legal_entity_id = ${legalEntityId}::uuid
                  and proposal_snapshot->'context'->>'marketId' = ${marketId}) as proposal_count`,
        'objects',
      )
      .pipe(Effect.map(one)),
  );

it.live(
  'serializes competing reservations, preserves exact evidence, and releases the Market for a fresh reservation',
  () =>
    Effect.scoped(
      Effect.gen(function* reservationReleaseAcceptance() {
        const { admin: adminClient, runtime: runtimeClient } = yield* acquireOutlivingCleanup(testDatabaseClients);
        const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);
        const cleanup = cleanupReservations(admin);

        yield* cleanup();
        yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

        const assessment = yield* assess(runtime, firstTenantId, firstLegalEntityId, firstMarketId, 17);
        const payload = reserveInput(assessment);
        const localEvidence = payload.sourceEvidence.filter(({ sourceId }) =>
          sourceId.startsWith('commerce.customer-context.'),
        );
        const invalidPayloads: readonly (readonly [string, ReservePayload, string])[] = [
          ['digest', { ...payload, assessmentDigest: 'f'.repeat(64) }, actionInvocationIds.invalidDigest],
          [
            'missing-proof',
            {
              ...payload,
              sourceEvidence: [...localEvidence, compositionEvidence('commerce.cart')],
            },
            actionInvocationIds.invalidMissingProof,
          ],
          [
            'expired-proof',
            {
              ...payload,
              sourceEvidence: [
                ...localEvidence,
                compositionEvidence('commerce.cart', { validUntil: '2021-01-01T00:00:00.000Z' }),
                compositionEvidence('commerce.order'),
              ],
            },
            actionInvocationIds.invalidExpiredProof,
          ],
          [
            'substituted-proof',
            {
              ...payload,
              sourceEvidence: [
                ...localEvidence,
                compositionEvidence('commerce.cart', {
                  sourceId: 'application-composition:commerce.checkout:UNIMPLEMENTED',
                }),
                compositionEvidence('commerce.order'),
              ],
            },
            actionInvocationIds.invalidSubstitutedProof,
          ],
        ];
        for (const [kind, invalidPayload, actionInvocationId] of invalidPayloads) {
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                execute(runtime, firstTenantId, firstLegalEntityId, invalidPayload, actionInvocationId),
              ),
            ),
            kind,
          ).toBe(true);
        }

        const attempts = yield* Effect.all(
          [
            execute(runtime, firstTenantId, firstLegalEntityId, payload, actionInvocationIds.firstReserve).pipe(
              Effect.exit,
            ),
            execute(runtime, firstTenantId, firstLegalEntityId, payload, actionInvocationIds.secondReserve).pipe(
              Effect.exit,
            ),
          ],
          { concurrency: 'unbounded' },
        );

        expect(attempts.filter(Exit.isSuccess)).toHaveLength(1);
        expect(attempts.filter(Exit.isFailure)).toHaveLength(1);
        expect(attempts.some(isReservationConflict)).toBe(true);

        const firstSucceeded = Exit.isSuccess(attempts[0]);
        const successfulAttempt = firstSucceeded ? attempts[0] : attempts[1];
        const reservation = yield* Exit.isSuccess(successfulAttempt)
          ? Effect.succeed(successfulAttempt.value)
          : Effect.failCause(successfulAttempt.cause);
        expect(reservation).toMatchObject({
          assessmentDigest: assessment.assessmentDigest,
          lifecycle: 'RESERVED',
          marketRevision: 17,
          reservationVersion: 1,
        });

        const stored = yield* admin.transaction((transaction) =>
          transaction
            .execute<ReservationRow>(
              sql`select assessment_digest, lifecycle, market_resource_id, market_revision,
                         reservation_version, source_evidence
                    from commerce_customer_context.market_retirement_reservations
                   where market_retirement_reservation_id = ${reservation.reservationToken}::uuid`,
              'objects',
            )
            .pipe(Effect.map(one)),
        );
        const storedEvidence = yield* Schema.decodeUnknownEffect(Schema.Array(MarketAffectedUseSourceEvidenceSchema))(
          stored.source_evidence,
        );
        expect(stored).toMatchObject({
          assessment_digest: assessment.assessmentDigest,
          lifecycle: 'RESERVED',
          market_resource_id: firstMarketId,
          market_revision: 17,
          reservation_version: 1,
        });
        expect(storedEvidence).toEqual(assessment.sourceEvidence);

        const reservedBootstrapWrite = yield* Effect.exit(
          mutateBootstrapReference(admin, firstTenantId, firstLegalEntityId, firstMarketId),
        );
        const reservedProposalWrite = yield* Effect.exit(
          mutatePurchaseProposalReference(admin, firstTenantId, firstLegalEntityId, firstMarketId),
        );
        expect(isReferenceGuardConflict(reservedBootstrapWrite)).toBe(true);
        expect(
          isReferenceGuardConflict(reservedProposalWrite),
          Exit.isFailure(reservedProposalWrite)
            ? Cause.pretty(reservedProposalWrite.cause)
            : 'proposal write succeeded',
        ).toBe(true);

        const winningActionInvocationId = firstSucceeded
          ? actionInvocationIds.firstReserve
          : actionInvocationIds.secondReserve;
        const wrongDigest = yield* Effect.exit(
          execute(
            runtime,
            firstTenantId,
            firstLegalEntityId,
            { ...payload, assessmentDigest: 'f'.repeat(64) },
            winningActionInvocationId,
          ),
        );
        expect(isReservationConflict(wrongDigest)).toBe(true);

        const wrongVersion = yield* Effect.exit(
          execute(
            runtime,
            firstTenantId,
            firstLegalEntityId,
            {
              ...releaseInput(reservation),
              reservationVersion: reservation.reservationVersion + 1,
            },
            actionInvocationIds.versionProbe,
          ),
        );
        expect(isReservationConflict(wrongVersion)).toBe(true);

        const released = yield* execute(
          runtime,
          firstTenantId,
          firstLegalEntityId,
          releaseInput(reservation),
          actionInvocationIds.release,
        );
        expect(released).toMatchObject({ lifecycle: 'RELEASED', reservationVersion: 2 });

        yield* mutateBootstrapReference(admin, firstTenantId, firstLegalEntityId, firstMarketId, true);
        yield* mutatePurchaseProposalReference(admin, firstTenantId, firstLegalEntityId, firstMarketId, true);

        const fresh = yield* execute(
          runtime,
          firstTenantId,
          firstLegalEntityId,
          payload,
          actionInvocationIds.freshReserve,
        );
        expect(fresh).toMatchObject({ lifecycle: 'RESERVED', reservationVersion: 1 });
        expect(fresh.reservationToken).not.toBe(reservation.reservationToken);
      }),
    ),
);

it.live('makes COMMIT terminal and idempotent for the exact Action retry', () =>
  Effect.scoped(
    Effect.gen(function* reservationCommitAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* acquireOutlivingCleanup(testDatabaseClients);
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);
      const cleanup = cleanupReservations(admin);

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const assessment = yield* assess(runtime, secondTenantId, secondLegalEntityId, secondMarketId, 23);
      const reservation = yield* execute(
        runtime,
        secondTenantId,
        secondLegalEntityId,
        reserveInput(assessment),
        actionInvocationIds.firstReserve,
      );
      const commitPayload = finishInput('COMMIT', reservation);
      const committed = yield* execute(
        runtime,
        secondTenantId,
        secondLegalEntityId,
        commitPayload,
        actionInvocationIds.commit,
      );
      const retried = yield* execute(
        runtime,
        secondTenantId,
        secondLegalEntityId,
        commitPayload,
        actionInvocationIds.commitRetry,
      );

      expect(committed).toMatchObject({ lifecycle: 'COMMITTED', reservationVersion: 2 });
      expect(retried).toEqual(committed);

      const committedBootstrapWrite = yield* Effect.exit(
        mutateBootstrapReference(admin, secondTenantId, secondLegalEntityId, secondMarketId),
      );
      const committedProposalWrite = yield* Effect.exit(
        mutatePurchaseProposalReference(admin, secondTenantId, secondLegalEntityId, secondMarketId),
      );
      expect(isReferenceGuardConflict(committedBootstrapWrite)).toBe(true);
      expect(
        isReferenceGuardConflict(committedProposalWrite),
        Exit.isFailure(committedProposalWrite)
          ? Cause.pretty(committedProposalWrite.cause)
          : 'proposal write succeeded',
      ).toBe(true);

      const terminalFailure = yield* Effect.exit(
        execute(
          runtime,
          secondTenantId,
          secondLegalEntityId,
          releaseInput(committed),
          actionInvocationIds.terminalRelease,
        ),
      );
      expect(isReservationConflict(terminalFailure)).toBe(true);
    }),
  ),
);

it.live('serializes a purchase-proposal source mutation racing RESERVE without admitting stale evidence', () =>
  Effect.scoped(
    Effect.gen(function* localSourceRaceAcceptance() {
      const { admin: adminClient, runtime: runtimeClient } = yield* acquireOutlivingCleanup(testDatabaseClients);
      const admin = yield* makeTestDatabaseFromClient(adminClient, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, commerceCustomerContextRelations);
      const cleanup = cleanupReservations(admin);

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const assessment = yield* assess(runtime, thirdTenantId, thirdLegalEntityId, thirdMarketId, 31);
      const [reserveAttempt, proposalWriteAttempt] = yield* Effect.all(
        [
          execute(
            runtime,
            thirdTenantId,
            thirdLegalEntityId,
            reserveInput(assessment),
            actionInvocationIds.raceReserve,
          ).pipe(Effect.exit),
          mutatePurchaseProposalReference(admin, thirdTenantId, thirdLegalEntityId, thirdMarketId).pipe(Effect.exit),
        ],
        { concurrency: 'unbounded' },
      );

      expect(Exit.isSuccess(reserveAttempt)).not.toBe(Exit.isSuccess(proposalWriteAttempt));
      expect(Exit.isFailure(reserveAttempt)).not.toBe(Exit.isFailure(proposalWriteAttempt));

      const state = yield* readRetirementRaceState(admin, thirdTenantId, thirdLegalEntityId, thirdMarketId);
      if (Exit.isSuccess(reserveAttempt)) {
        expect(
          isReferenceGuardConflict(proposalWriteAttempt),
          Exit.isFailure(proposalWriteAttempt) ? Cause.pretty(proposalWriteAttempt.cause) : 'proposal write succeeded',
        ).toBe(true);
        expect(state).toEqual({ proposal_count: 0, reservation_count: 1 });
      } else {
        expect(isReservationConflict(reserveAttempt)).toBe(true);
        expect(Exit.isSuccess(proposalWriteAttempt)).toBe(true);
        expect(state).toEqual({ proposal_count: 1, reservation_count: 0 });
      }
    }),
  ),
);
