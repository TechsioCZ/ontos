import {
  PricingZeroFloorAuthorizationQuerySchema,
  PricingZeroFloorAuthorizationSchema,
} from '@app/pricing-contracts/domain/line-composition';
import type {
  PricingZeroFloorAuthorization,
  PricingZeroFloorAuthorizationQuery,
} from '@app/pricing-contracts/domain/line-composition';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  CreateZeroFloorAuthorizationPersistenceOutcomeSchema,
  ManageZeroFloorAuthorizationPersistenceOutcomeSchema,
  ReadCurrentZeroFloorAuthorizationGovernanceProofOutcomeSchema,
  ReadCurrentZeroFloorAuthorizationSetPersistenceOutcomeSchema,
  ReadZeroFloorAuthorizationSchedulePersistenceOutcomeSchema,
  VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcomeSchema,
  ZeroFloorAuthorizationResultLookupOutcomeSchema,
} from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { ZeroFloorAuthorizationScheduleAcknowledgementSchema } from '../../shared/actions/manage-zero-floor-authorization.ts';
import type {
  ExpectedZeroFloorAuthorizationCurrent,
  ZeroFloorAuthorizationScheduleAcknowledgement,
} from '../../shared/actions/manage-zero-floor-authorization.ts';

const tenantId = 'e7970000-0000-4000-8000-000000000701';
const legalEntityId = 'e7970000-0000-4000-8000-000000000702';
const otherLegalEntityId = 'e7970000-0000-4000-8000-000000000706';
const principalId = 'pricing-governance:postgres:797';
const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const RoutineOutcomeSchema = Schema.Struct({
  acknowledgement: Schema.optionalKey(Schema.Unknown),
  authority: Schema.optionalKey(Schema.Unknown),
  authorizationSet: Schema.optionalKey(Schema.Unknown),
  governanceProof: Schema.optionalKey(Schema.Unknown),
  outcome: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  schedule: Schema.optionalKey(Schema.Unknown),
  setGeneration: Schema.optionalKey(Schema.Finite),
});

interface ZeroFloorRoutineInput {
  readonly acknowledgement?: ZeroFloorAuthorizationScheduleAcknowledgement;
  readonly actingPrincipalId?: string;
  readonly actionInvocationId?: string;
  readonly approvalRevision?: string;
  readonly authorization?: PricingZeroFloorAuthorization;
  readonly authorizationRef?: string;
  readonly effectiveAt?: typeof PricingInstantSchema.Type;
  readonly effectiveTo?: string;
  readonly expectedCurrent?: ExpectedZeroFloorAuthorizationCurrent;
  readonly expectedSetGeneration?: number;
  readonly generation?: number;
  readonly governanceProof?: unknown;
  readonly intent?: 'APPROVE' | 'CORRECT_REVISION' | 'END_CURRENT' | 'SUCCESSOR';
  readonly observedAt?: typeof PricingInstantSchema.Type;
  readonly ownerRevision?: string;
  readonly ownerRootRef?: string;
  readonly query?: PricingZeroFloorAuthorizationQuery;
  readonly reason?: string;
  readonly requestCorrelationId?: string;
  readonly targetRevision?: string;
  readonly tenantId?: string;
  readonly through?: string;
  readonly trustedOperationAt?: typeof PricingInstantSchema.Type;
  readonly validityPeriod?: {
    readonly endsAt: typeof PricingInstantSchema.Type;
    readonly startsAt: typeof PricingInstantSchema.Type;
  };
}

const fixtureAuthorization = (now: number) =>
  Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
    authorizationRef: 'pricing:zero-floor-postgres:797',
    authorizationRevision: 'pricing:zero-floor-postgres:797:r1',
    businessScope: {
      catalogSelection: {
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e7970000-0000-4000-8000-000000000703',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e7970000-0000-4000-8000-000000000704',
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      },
      commercialScope: {
        channelId: 'B2B',
        marketId: 'zero-floor-postgres-market',
        sellingLegalEntityId: legalEntityId,
      },
      pricingBasis: {
        quantity: '1',
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'e7970000-0000-4000-8000-000000000705',
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        },
      },
      tenantId,
    },
    coveredMeaning: {
      audienceRefs: ['zero-floor-postgres-audience'],
      materialRevisionRefs: ['zero-floor-postgres-material-r1'],
    },
    currencyCode: 'CZK',
    economicCoverage: {
      maximumFloorAdjustment: '100',
      minimumRawAmount: '-100',
    },
    effectivePeriod: {
      endsAt: isoAt(now + 86_400_000),
      startsAt: isoAt(now - 3_600_000),
    },
    governanceEvidence: {
      approvalEvidenceRef: 'pricing:zero-floor-postgres:797:approval',
      approvedByPrincipalRef: principalId,
      reason: 'Exact bounded Postgres approval',
    },
  });

it.live('persists ZERO_FLOOR approval separately and redeems it for exact CREATE and Current proof', () =>
  Effect.scoped(
    Effect.gen(function* zeroFloorPostgresContract() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, coreRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const cleanup = Effect.gen(function* cleanupZeroFloorFixture() {
        yield* admin.execute(
          sql`delete from pricing.zero_floor_action_invocation_receipts where tenant_id = ${tenantId}::uuid`,
        );
        yield* admin.execute(
          sql`delete from pricing.zero_floor_schedule_acknowledgements where tenant_id = ${tenantId}::uuid`,
        );
        yield* admin.execute(
          sql`delete from pricing.zero_floor_governance_approvals where tenant_id = ${tenantId}::uuid`,
        );
        yield* admin.execute(
          sql`delete from pricing.zero_floor_authorization_schedule_heads where tenant_id = ${tenantId}::uuid`,
        );
        yield* admin.execute(
          sql`delete from pricing.zero_floor_authorization_revisions where tenant_id = ${tenantId}::uuid`,
        );
        yield* admin.execute(sql`delete from pricing.zero_floor_authorizations where tenant_id = ${tenantId}::uuid`);
        yield* admin.execute(sql`delete from pricing.zero_floor_set_heads where tenant_id = ${tenantId}::uuid`);
        yield* admin.execute(sql`delete from pricing.zero_floor_set_revisions where tenant_id = ${tenantId}::uuid`);
        yield* admin.execute(sql`delete from pricing.zero_floor_set_roots where tenant_id = ${tenantId}::uuid`);
      });
      yield* cleanup;
      yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));

      const databaseNow = Effect.gen(function* readDatabaseNow() {
        const [row] = yield* admin.execute<{ readonly instant: string }>(
          sql`select to_char(statement_timestamp() at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as instant`,
          'objects',
        );
        if (row === undefined) {
          return yield* Effect.die('Database did not return its operation time');
        }
        return DateTime.toEpochMillis(DateTime.makeUnsafe(row.instant));
      });
      const now = yield* databaseNow;
      const authorization = yield* fixtureAuthorization(now);
      const trustedOperationAt = isoAt(now);
      const validityPeriod = {
        endsAt: isoAt(now + 86_400_000),
        startsAt: isoAt(now - 3_600_000),
      };
      const invoke = (
        routine: 'manage' | 'create' | 'proof' | 'read' | 'verify' | 'schedule' | 'lookup',
        input: ZeroFloorRoutineInput,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* invokeZeroFloorRoutine() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
              set_config('ontos.legal_entity_id', ${legalEntityId}, true)`);
            const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input);
            let rows: readonly { readonly payload: unknown }[];
            if (routine === 'manage') {
              rows = yield* transaction.execute<{ readonly payload: unknown }>(
                sql`select payload from pricing.manage_zero_floor_authorization_v1(
                    ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
                'objects',
              );
            } else if (routine === 'create') {
              rows = yield* transaction.execute<{ readonly payload: unknown }>(
                sql`select payload from pricing.create_zero_floor_authorization_v1(
                      ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
                'objects',
              );
            } else if (routine === 'proof') {
              rows = yield* transaction.execute<{ readonly payload: unknown }>(
                sql`select payload from pricing.read_current_zero_floor_authorization_governance_proof_v1(
                        ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
                'objects',
              );
            } else if (routine === 'read') {
              rows = yield* transaction.execute<{ readonly payload: unknown }>(
                sql`select payload from pricing.read_current_zero_floor_authorization_set_v1(
                          ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
                'objects',
              );
            } else if (routine === 'verify') {
              rows = yield* transaction.execute<{ readonly payload: unknown }>(
                sql`select payload from pricing.verify_zero_floor_authorization_set_generation_v1(
                            ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
                'objects',
              );
            } else if (routine === 'schedule') {
              rows = yield* transaction.execute<{ readonly payload: unknown }>(
                sql`select payload from pricing.read_zero_floor_authorization_schedule_v1(
                              ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
                'objects',
              );
            } else {
              rows = yield* transaction.execute<{ readonly payload: unknown }>(
                sql`select payload from pricing.lookup_zero_floor_authorization_result_v1(
                          ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
                'objects',
              );
            }
            const [first] = rows;
            if (rows.length !== 1 || first === undefined) {
              return yield* Effect.die('ZERO_FLOOR routine returned an ambiguous result');
            }
            if (routine === 'manage') {
              yield* Schema.decodeUnknownEffect(ManageZeroFloorAuthorizationPersistenceOutcomeSchema)(first.payload);
            } else if (routine === 'create') {
              yield* Schema.decodeUnknownEffect(CreateZeroFloorAuthorizationPersistenceOutcomeSchema)(first.payload);
            } else if (routine === 'proof') {
              yield* Schema.decodeUnknownEffect(ReadCurrentZeroFloorAuthorizationGovernanceProofOutcomeSchema)(
                first.payload,
              );
            } else if (routine === 'read') {
              yield* Schema.decodeUnknownEffect(ReadCurrentZeroFloorAuthorizationSetPersistenceOutcomeSchema)(
                first.payload,
              );
            } else if (routine === 'verify') {
              yield* Schema.decodeUnknownEffect(VerifyZeroFloorAuthorizationSetGenerationPersistenceOutcomeSchema)(
                first.payload,
              );
            } else if (routine === 'schedule') {
              yield* Schema.decodeUnknownEffect(ReadZeroFloorAuthorizationSchedulePersistenceOutcomeSchema)(
                first.payload,
              );
            } else {
              yield* Schema.decodeUnknownEffect(ZeroFloorAuthorizationResultLookupOutcomeSchema)(first.payload);
            }
            return yield* Schema.decodeUnknownEffect(RoutineOutcomeSchema)(first.payload);
          }),
        );

      const approval = yield* invoke('manage', {
        actingPrincipalId: principalId,
        actionInvocationId: 'zero-floor-postgres:797:approve',
        approvalRevision: 'zero-floor-postgres:797:approval:r1',
        authorization,
        expectedSetGeneration: 1,
        intent: 'APPROVE',
        reason: 'Persist separately approved bounded coverage',
        requestCorrelationId: 'zero-floor-postgres:797:approve',
        trustedOperationAt,
        validityPeriod,
      });
      expect(approval.outcome).toBe('ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED');
      expect(approval.setGeneration).toBe(2);

      const currentProof = yield* invoke('proof', { authorization, effectiveAt: trustedOperationAt });
      expect(currentProof.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_GOVERNANCE_PROOF_CURRENT');
      const created = yield* invoke('create', {
        actingPrincipalId: principalId,
        actionInvocationId: 'zero-floor-postgres:797:create',
        authorization,
        expectedSetGeneration: 2,
        governanceProof: currentProof.governanceProof,
        reason: 'Create from persisted approval proof',
        requestCorrelationId: 'zero-floor-postgres:797:create',
        trustedOperationAt,
      });
      expect(created.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_CREATED');
      expect(created.setGeneration).toBe(3);

      const schedule = yield* invoke('schedule', {
        authorizationRef: authorization.authorizationRef,
        tenantId,
        trustedOperationAt,
      });
      expect(schedule).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_SCHEDULE' });

      const queryWithoutRef = {
        audienceRefs: authorization.coveredMeaning.audienceRefs,
        catalogSelection: authorization.businessScope.catalogSelection,
        commercialScope: authorization.businessScope.commercialScope,
        currencyCode: authorization.currencyCode,
        effectiveAt: trustedOperationAt,
        materialRevisionRefs: authorization.coveredMeaning.materialRevisionRefs,
        pricingBasis: authorization.businessScope.pricingBasis,
        tenantId,
      };
      const encodedQueryWithoutRef = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(queryWithoutRef);
      const predicateRows = yield* admin.execute<{ readonly ref: string }>(
        sql`select pricing.zero_floor_predicate_ref_v1(${encodedQueryWithoutRef}::jsonb) as ref`,
        'objects',
      );
      const [predicateRow] = predicateRows;
      if (predicateRow === undefined) {
        return yield* Effect.die('ZERO_FLOOR predicate helper returned no reference');
      }
      const query = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationQuerySchema)({
        ...queryWithoutRef,
        exactPredicateRef: predicateRow.ref,
      });
      const currentSet = yield* invoke('read', { query });
      expect(currentSet).toMatchObject({
        authorizationSet: { authorizations: [{ authorizationRef: authorization.authorizationRef }] },
        outcome: 'ZERO_FLOOR_AUTHORIZATION_SET_CURRENT',
      });
      const authority = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          generation: Schema.Finite,
          observedAt: PricingInstantSchema,
          ownerRevision: Schema.String,
          ownerRootRef: Schema.String,
        }),
      )(currentSet.authority);
      const verified = yield* invoke('verify', {
        ...authority,
        query,
        through: authority.observedAt,
      });
      expect(verified.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT');

      const wrongLegalEntityFailure = yield* Effect.flip(
        runtime.transaction((transaction) =>
          Effect.gen(function* invokeWithWrongLegalEntityScope() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true),
              set_config('ontos.legal_entity_id', ${otherLegalEntityId}, true)`);
            const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ query });
            yield* transaction.execute(
              sql`select payload from pricing.read_current_zero_floor_authorization_set_v1(
                ${tenantId}::uuid, ${legalEntityId}::uuid, ${body}::jsonb)`,
              'objects',
            );
          }),
        ),
      );
      expect(wrongLegalEntityFailure).toBeDefined();

      const replay = yield* invoke('lookup', {
        actingPrincipalId: principalId,
        actionInvocationId: 'zero-floor-postgres:797:create',
      });
      expect(replay).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_FOUND', result: created });
      const wrongActor = yield* invoke('lookup', {
        actingPrincipalId: 'another-principal',
        actionInvocationId: 'zero-floor-postgres:797:create',
      });
      expect(wrongActor.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_RESULT_ABSENT');

      const successorAt = yield* databaseNow;
      const successorOperationAt = isoAt(successorAt);
      const futureStartsAt = isoAt(successorAt + 600_000);
      const successor = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
        ...authorization,
        authorizationRevision: 'pricing:zero-floor-postgres:797:r2',
        effectivePeriod: { ...authorization.effectivePeriod, startsAt: futureStartsAt },
      });
      const successorProof = yield* invoke('proof', {
        authorization: successor,
        effectiveAt: successorOperationAt,
      });
      expect(successorProof.governanceProof).toMatchObject({
        approvalEvidence: {
          approvalRevision: 'zero-floor-postgres:797:approval:r1',
          authorization: { authorizationRevision: authorization.authorizationRevision },
        },
        authorization: { authorizationRevision: successor.authorizationRevision },
      });
      const reusedRevision = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
        ...successor,
        authorizationRevision: authorization.authorizationRevision,
      });
      const reusedRevisionProof = yield* invoke('proof', {
        authorization: reusedRevision,
        effectiveAt: successorOperationAt,
      });
      const revisionCollision = yield* invoke('manage', {
        actingPrincipalId: principalId,
        actionInvocationId: 'zero-floor-postgres:797:successor-reused-revision',
        authorization: reusedRevision,
        expectedCurrent: {
          authorizationRef: authorization.authorizationRef,
          authorizationRevision: authorization.authorizationRevision,
          effectivePeriod: authorization.effectivePeriod,
          scheduleRevision: 1,
        },
        expectedSetGeneration: 3,
        governanceProof: reusedRevisionProof.governanceProof,
        intent: 'SUCCESSOR',
        reason: 'Reject reuse of an immutable Authorization Revision identifier',
        requestCorrelationId: 'zero-floor-postgres:797:successor-reused-revision',
        trustedOperationAt: successorOperationAt,
      });
      expect(revisionCollision).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        reason: 'AUTHORIZATION_REF_ALREADY_BOUND',
      });
      const successorResult = yield* invoke('manage', {
        actingPrincipalId: principalId,
        actionInvocationId: 'zero-floor-postgres:797:successor',
        authorization: successor,
        expectedCurrent: {
          authorizationRef: authorization.authorizationRef,
          authorizationRevision: authorization.authorizationRevision,
          effectivePeriod: authorization.effectivePeriod,
          scheduleRevision: 1,
        },
        expectedSetGeneration: 3,
        governanceProof: successorProof.governanceProof,
        intent: 'SUCCESSOR',
        reason: 'Preserve the future boundary',
        requestCorrelationId: 'zero-floor-postgres:797:successor',
        trustedOperationAt: successorOperationAt,
      });
      expect(successorResult.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_SUCCEEDED');
      expect(successorResult.setGeneration).toBe(4);
      const changedGeneration = yield* invoke('verify', {
        ...authority,
        query,
        through: successorOperationAt,
      });
      expect(changedGeneration.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CHANGED');

      const correctionBase = {
        actingPrincipalId: principalId,
        expectedScheduleRevision: 2,
        expectedSetGeneration: 4,
        intent: 'CORRECT_REVISION' as const,
        reason: 'Correct a future revision without expanding its approved semantics',
        targetRevision: successor.authorizationRevision,
        trustedOperationAt: successorOperationAt,
      };
      const scopeExpansion = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
        ...successor,
        authorizationRevision: 'pricing:zero-floor-postgres:797:r2-scope-expansion',
        coveredMeaning: {
          ...successor.coveredMeaning,
          audienceRefs: [...successor.coveredMeaning.audienceRefs, 'zero-floor-postgres-audience-expanded'],
        },
      });
      const scopeExpansionResult = yield* invoke('manage', {
        ...correctionBase,
        actionInvocationId: 'zero-floor-postgres:797:correct-scope-expansion',
        authorization: scopeExpansion,
        requestCorrelationId: 'zero-floor-postgres:797:correct-scope-expansion',
      });
      expect(scopeExpansionResult).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        reason: 'SCOPE_EXPANSION_REQUIRES_SUCCESSOR',
      });

      const economicExpansion = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
        ...successor,
        authorizationRevision: 'pricing:zero-floor-postgres:797:r2-economic-expansion',
        economicCoverage: { maximumFloorAdjustment: '101', minimumRawAmount: '-101' },
      });
      const economicExpansionResult = yield* invoke('manage', {
        ...correctionBase,
        actionInvocationId: 'zero-floor-postgres:797:correct-economic-expansion',
        authorization: economicExpansion,
        requestCorrelationId: 'zero-floor-postgres:797:correct-economic-expansion',
      });
      expect(economicExpansionResult).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        reason: 'SCOPE_EXPANSION_REQUIRES_SUCCESSOR',
      });

      const effectivityExpansion = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
        ...successor,
        authorizationRevision: 'pricing:zero-floor-postgres:797:r2-effectivity-expansion',
        effectivePeriod: { ...successor.effectivePeriod, startsAt: isoAt(successorAt + 540_000) },
      });
      const effectivityExpansionResult = yield* invoke('manage', {
        ...correctionBase,
        actionInvocationId: 'zero-floor-postgres:797:correct-effectivity-expansion',
        authorization: effectivityExpansion,
        requestCorrelationId: 'zero-floor-postgres:797:correct-effectivity-expansion',
      });
      expect(effectivityExpansionResult).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
        reason: 'SCOPE_EXPANSION_REQUIRES_SUCCESSOR',
      });

      const narrowedCorrection = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
        ...successor,
        authorizationRevision: 'pricing:zero-floor-postgres:797:r2-correction',
        coveredMeaning: { ...successor.coveredMeaning, audienceRefs: [] },
        economicCoverage: { maximumFloorAdjustment: '99', minimumRawAmount: '-99' },
        effectivePeriod: {
          endsAt: isoAt(now + 86_340_000),
          startsAt: isoAt(successorAt + 660_000),
        },
        governanceEvidence: {
          ...successor.governanceEvidence,
          approvalEvidenceRef: 'pricing:zero-floor-postgres:797:approval-correction',
          reason: 'Approve a narrowed correction',
        },
      });
      const correctionApproval = yield* invoke('manage', {
        actingPrincipalId: principalId,
        actionInvocationId: 'zero-floor-postgres:797:approve-correction',
        approvalRevision: 'zero-floor-postgres:797:approval-correction:r1',
        authorization: narrowedCorrection,
        expectedSetGeneration: 4,
        intent: 'APPROVE',
        reason: 'Persist approval for the narrowed correction',
        requestCorrelationId: 'zero-floor-postgres:797:approve-correction',
        trustedOperationAt: successorOperationAt,
        validityPeriod,
      });
      expect(correctionApproval).toMatchObject({
        outcome: 'ZERO_FLOOR_GOVERNANCE_APPROVAL_RECORDED',
        setGeneration: 5,
      });
      const correctionProof = yield* invoke('proof', {
        authorization: narrowedCorrection,
        effectiveAt: successorOperationAt,
      });
      const correctionCommand = {
        ...correctionBase,
        actionInvocationId: 'zero-floor-postgres:797:correct-narrowing',
        authorization: narrowedCorrection,
        expectedSetGeneration: 5,
        governanceProof: correctionProof.governanceProof,
        requestCorrelationId: 'zero-floor-postgres:797:correct-narrowing',
      };
      const correctionWarning = yield* invoke('manage', correctionCommand);
      expect(correctionWarning.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_ACKNOWLEDGEMENT_REQUIRED');
      const correctionAcknowledgement = yield* Schema.decodeUnknownEffect(
        ZeroFloorAuthorizationScheduleAcknowledgementSchema,
      )(correctionWarning.acknowledgement);
      const corrected = yield* invoke('manage', {
        ...correctionCommand,
        acknowledgement: correctionAcknowledgement,
      });
      expect(corrected).toMatchObject({
        outcome: 'ZERO_FLOOR_AUTHORIZATION_CORRECTED',
        schedule: {
          revisions: [
            {},
            {
              authorization: { authorizationRevision: successor.authorizationRevision },
              scheduleState: 'SUPERSEDED',
            },
            {
              authorization: { authorizationRevision: narrowedCorrection.authorizationRevision },
              lineage: {
                correctedRevision: successor.authorizationRevision,
                predecessorRevision: successor.authorizationRevision,
                rootAuthorizationRef: successor.authorizationRef,
                transition: 'CORRECTED',
              },
            },
          ],
          scheduleRevision: 3,
        },
        setGeneration: 6,
      });

      const endingAt = yield* databaseNow;
      const endOperationAt = isoAt(endingAt);
      const currentAuthorization = yield* Schema.decodeEffect(PricingZeroFloorAuthorizationSchema)({
        ...authorization,
        effectivePeriod: { ...authorization.effectivePeriod, endsAt: futureStartsAt },
      });
      const endCommand = {
        actingPrincipalId: principalId,
        actionInvocationId: 'zero-floor-postgres:797:end',
        authorization: currentAuthorization,
        authorizationRef: authorization.authorizationRef,
        effectiveTo: endOperationAt,
        expectedCurrent: {
          authorizationRef: authorization.authorizationRef,
          authorizationRevision: authorization.authorizationRevision,
          effectivePeriod: currentAuthorization.effectivePeriod,
          scheduleRevision: 3,
        },
        expectedSetGeneration: 6,
        intent: 'END_CURRENT' as const,
        reason: 'End the Current authorization with explicit future schedule acknowledgement',
        requestCorrelationId: 'zero-floor-postgres:797:end',
        trustedOperationAt: endOperationAt,
      };
      const warning = yield* invoke('manage', endCommand);
      expect(warning.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_ACKNOWLEDGEMENT_REQUIRED');
      const acknowledgement = yield* Schema.decodeUnknownEffect(ZeroFloorAuthorizationScheduleAcknowledgementSchema)(
        warning.acknowledgement,
      );
      const forged = yield* invoke('manage', {
        ...endCommand,
        acknowledgement: { ...acknowledgement, presentedScheduleFingerprint: '0'.repeat(64) },
        actionInvocationId: 'zero-floor-postgres:797:end-forged',
      });
      expect(forged).toMatchObject({ outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT', reason: 'ACKNOWLEDGEMENT_STALE' });
      const ended = yield* invoke('manage', { ...endCommand, acknowledgement });
      expect(ended.outcome).toBe('ZERO_FLOOR_AUTHORIZATION_ENDED');
      expect(ended.setGeneration).toBe(7);
      return null;
    }),
  ),
);
