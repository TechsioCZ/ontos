import { defineScopedRoutine, requireModuleOperation } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { CounterpartyMigrationCorrelationResponseSchema } from '@app/party-registry/apis/counterparty-migration-correlation';
import type { LegacyIcoInventoryAssertion } from '@app/party-registry/apis/legacy-ico-inventory';
import { OrganizationProfileIcoMigrationLegacySchema } from '../../shared/domain/organization-profile-ico-migration.ts';
import { CommerceOrganizationProfileIcoEligibility } from '../integrations/organization-profile-ico-eligibility.ts';
import { DateTime, Effect, Option, Schema } from 'effect';
import { CommerceLegacyIcoInventory } from '../integrations/party-legacy-ico-inventory.ts';
import { CommerceSourceProcessingEligibility } from '../integrations/source-processing-eligibility.ts';
import type { CommerceSourceProcessingRejected } from '../integrations/source-processing-eligibility.ts';
import {
  CustomerProfileIcoMigrationTargetSchema,
  ProfileIcoMigrationOrganizationAuthoritySchema,
  MigrateCustomerProfileIcoResultSchema,
  CustomerProfileIcoMigrationRejected,
  classifyCustomerProfileIcoMigration,
  customerProfileIcoMigrationInventoryVersion,
} from '../../shared/domain/customer-profile-ico-migration.ts';
import type {
  CustomerProfileIcoMigrationInputSchema,
  CustomerProfileIcoMigrationPlan,
  MigrateCustomerProfileIcoPayload,
} from '../../shared/domain/customer-profile-ico-migration.ts';

const OWNER = 'commerce.customer-context';
const MIGRATION_OPERATION = 'customer-profile-ico.migrate';
const inventoryRoutine = defineScopedRoutine({
  name: 'profile_ico_target_inventory',
  ownerModuleKey: OWNER,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({
    result: Schema.Struct({
      authorityRevision: Schema.optionalKey(Schema.toEncoded(Schema.OptionFromNullOr(Schema.Int))),
      targets: Schema.Array(CustomerProfileIcoMigrationTargetSchema),
      version: Schema.String,
    }),
  }),
  routineKey: 'customer-profile-ico.target-inventory',
  schema: 'commerce_customer_context',
});
const applyRoutine = defineScopedRoutine({
  name: 'migrate_customer_profile_ico',
  ownerModuleKey: OWNER,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: Schema.Struct({ outcome: Schema.String, result: Schema.Unknown }),
  routineKey: 'customer-profile-ico.migrate',
  schema: 'commerce_customer_context',
});
const MigrationApplyEvidenceSchema = Schema.Struct({
  authorityReadCount: Schema.Int,
  ledgerReads: Schema.Array(
    Schema.Struct({ profileRef: CustomerProfileIcoMigrationTargetSchema.fields.profileRef, resultCount: Schema.Int }),
  ),
});
type MigrationInput = typeof CustomerProfileIcoMigrationInputSchema.Type;
export interface CustomerProfileIcoMigrationServices {
  readonly apply: (
    input: MigrateCustomerProfileIcoPayload,
    invocationId: string,
  ) => Effect.Effect<
    Readonly<{
      authorityReadCount: number;
      ledgerReads: typeof MigrationApplyEvidenceSchema.Type.ledgerReads;
      result: typeof MigrateCustomerProfileIcoResultSchema.Type;
      targetInventoryCount: number;
    }>,
    CustomerProfileIcoMigrationRejected
  >;
  readonly report: (
    input: MigrationInput,
  ) => Effect.Effect<CustomerProfileIcoMigrationPlan, CustomerProfileIcoMigrationRejected>;
}
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new CustomerProfileIcoMigrationRejected({
      code: 'PERSISTENCE_UNAVAILABLE',
      reason: 'Commerce migration evidence is unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const privacyDenied = (cause: unknown) =>
  Object.defineProperty(
    new CustomerProfileIcoMigrationRejected({
      code: 'PRIVACY_DENIED',
      reason: 'Current Privacy authority does not permit the exact migration evidence',
    }),
    'cause',
    { configurable: true, value: cause },
  );
export const customerProfileIcoMigrationServices: ReadServiceFactory<
  CustomerProfileIcoMigrationServices,
  CommerceLegacyIcoInventory | CommerceSourceProcessingEligibility | CommerceOrganizationProfileIcoEligibility
> = Effect.fn('CustomerProfileIcoMigrationPersistence.services')(function* migrationServices(transaction, scope) {
  const party = yield* CommerceLegacyIcoInventory;
  const privacy = yield* CommerceSourceProcessingEligibility;
  const organization = yield* CommerceOrganizationProfileIcoEligibility;
  const correlateTarget = Effect.fn('CustomerProfileIcoMigration.correlateTarget')(function* correlateTarget(
    target: typeof CustomerProfileIcoMigrationTargetSchema.Type,
    operation: 'report' | 'migrate',
  ) {
    if (target.profileRef.kind === 'RETAIL' || target.legalEntityId !== scope.legalEntityId) {
      return target;
    }
    yield* requireModuleOperation(`commerce.customer-context.requirement.profile-ico-${operation}-counterparty`).pipe(
      Effect.mapError(unavailable),
    );
    const partyCorrelation = yield* party.correlate(
      scope,
      {
        moduleId: 'party.registry',
        resourceId: target.subjectResourceId,
        resourceType: 'party.registry.counterparty',
        tenantId: scope.tenantId,
      },
      { operationRequirementKey: `commerce.customer-context.requirement.profile-ico-${operation}-counterparty` },
    );
    return Option.isSome(partyCorrelation) ? { ...target, partyCorrelation: partyCorrelation.value } : target;
  });
  const organizationFallback = Effect.fn('CustomerProfileIcoMigration.organizationFallback')(
    function* organizationFallback(
      target: typeof CustomerProfileIcoMigrationTargetSchema.Type,
      assertions: readonly LegacyIcoInventoryAssertion[],
      operation: 'report' | 'migrate',
      error: CommerceSourceProcessingRejected,
    ) {
      if (target.profileRef.kind !== 'COUNTERPARTY' || target.legalEntityId !== scope.legalEntityId) {
        return yield* privacyDenied(error);
      }
      const { kind: _kind, ...profileRef } = target.profileRef;
      const prefix = `commerce.customer-context.requirement.profile-ico-${operation}-organization`;
      const authority = yield* organization
        .check(scope, { operation: MIGRATION_OPERATION, profileRef }, `${prefix}-privacy`)
        .pipe(Effect.mapError(privacyDenied));
      const relevant = assertions.filter((record) => record.partyRef.resourceId === authority.partyRef.resourceId);
      const safeRows = yield* Schema.decodeUnknownEffect(Schema.Array(OrganizationProfileIcoMigrationLegacySchema), {
        onExcessProperty: 'error',
      })(relevant).pipe(Effect.mapError(privacyDenied));
      if (
        safeRows.some(
          (record) =>
            record.provenance.ownerReceiptRef.resourceId !== record.assertionRef.resourceId ||
            record.provenance.ownerReceiptRef.tenantId !== scope.tenantId,
        )
      ) {
        return yield* privacyDenied(error);
      }
      yield* requireModuleOperation(`${prefix}-counterparty`).pipe(Effect.mapError(unavailable));
      const current = yield* party.correlate(
        scope,
        {
          moduleId: 'party.registry',
          resourceId: target.subjectResourceId,
          resourceType: 'party.registry.counterparty',
          tenantId: scope.tenantId,
        },
        { operationRequirementKey: `${prefix}-counterparty`, organizationOnly: true },
      );
      if (
        Option.isNone(current) ||
        current.value.organizationProof === undefined ||
        current.value.partyRef.resourceId !== authority.partyRef.resourceId ||
        current.value.organizationProof.partyRevision !== authority.partyRevision ||
        authority.profileRevision !== target.revision
      ) {
        return yield* privacyDenied(error);
      }
      const partyCorrelation = yield* Schema.decodeUnknownEffect(CounterpartyMigrationCorrelationResponseSchema)(
        current.value,
      ).pipe(Effect.mapError(unavailable));
      const organizationIcoAuthority = yield* Schema.decodeUnknownEffect(
        ProfileIcoMigrationOrganizationAuthoritySchema,
      )(authority).pipe(Effect.mapError(unavailable));
      return {
        ...target,
        organizationCorrelation: current.value.organizationProof,
        organizationIcoAuthority,
        partyCorrelation,
      };
    },
  );
  const prepare = Effect.fn('CustomerProfileIcoMigration.prepare')(function* prepare(
    input: MigrationInput,
    operation: 'report' | 'migrate',
  ) {
    yield* requireModuleOperation(`commerce.customer-context.requirement.profile-ico-${operation}-inventory`).pipe(
      Effect.mapError(unavailable),
    );
    yield* requireModuleOperation(`commerce.customer-context.requirement.profile-ico-${operation}-privacy`).pipe(
      Effect.mapError(unavailable),
    );
    const [inventory, targetRows] = yield* Effect.all(
      [
        party.read(scope, {
          operationRequirementKey: `commerce.customer-context.requirement.profile-ico-${operation}-inventory`,
        }),
        transaction.invoke(inventoryRoutine, []).pipe(Effect.mapError(unavailable)),
      ],
      { concurrency: 2 },
    );
    const [targets] = targetRows;
    if (targets === undefined) {
      return yield* unavailable();
    }
    const correlatedTargets = yield* Effect.forEach(
      targets.result.targets,
      (target) => correlateTarget(target, operation),
      { concurrency: 1 },
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    if (input.asOf > now) {
      return yield* new CustomerProfileIcoMigrationRejected({
        code: 'STALE_PLAN',
        reason: 'Migration cannot promote future facts',
      });
    }
    yield* privacy
      .check(
        scope,
        { operation: MIGRATION_OPERATION, source: input.sourceContext, target: null },
        `commerce.customer-context.requirement.profile-ico-${operation}-privacy`,
      )
      .pipe(Effect.mapError(privacyDenied));
    const authorizedTargets = yield* Effect.forEach(
      correlatedTargets,
      Effect.fn('CustomerProfileIcoMigration.authorizeTarget')(function* authorizeTarget(target) {
        const personal = privacy.check(
          scope,
          {
            operation: MIGRATION_OPERATION,
            source: input.sourceContext,
            target: {
              kind: target.profileRef.kind === 'RETAIL' ? 'RETAIL_CUSTOMER_PROFILE' : 'COUNTERPARTY_PURCHASING_PROFILE',
              resourceId: target.profileRef.resourceId,
            },
          },
          `commerce.customer-context.requirement.profile-ico-${operation}-privacy`,
        );
        return yield* personal.pipe(
          Effect.as(target),
          Effect.catch((error) => organizationFallback(target, inventory.assertions, operation, error)),
        );
      }),
      { concurrency: 1 },
    );
    const classified = classifyCustomerProfileIcoMigration(
      input,
      inventory,
      authorizedTargets,
      targets.result.version,
      {
        authorityRevision: targets.result.authorityRevision ?? null,
        legalEntityId: scope.legalEntityId ?? '',
        observedAt: now,
      },
    );
    return {
      inventory,
      plan: {
        ...classified,
        nativeTargetInventoryVersion: targets.result.version,
        targetInventoryVersion: customerProfileIcoMigrationInventoryVersion(
          targets.result.version,
          authorizedTargets,
          classified.records,
        ),
      },
      targetInventoryCount: targets.result.targets.length,
    };
  });
  return {
    apply: Effect.fn('CustomerProfileIcoMigration.apply')(function* apply(input, invocationId) {
      const { inventory, plan, targetInventoryCount } = yield* prepare(
        { asOf: input.asOf, planId: input.planId, reason: input.reason, sourceContext: input.sourceContext },
        'migrate',
      );
      if (
        plan.partySnapshotVersion !== input.expectedPartySnapshotVersion ||
        plan.targetInventoryVersion !== input.expectedTargetInventoryVersion
      ) {
        return yield* new CustomerProfileIcoMigrationRejected({
          code: 'STALE_PLAN',
          reason: 'A complete inventory changed after the approved report',
        });
      }
      const fence = inventory.authority.kind === 'COMMERCE_FENCED' ? inventory.authority.proof : null;
      if (
        (input.operation === 'CUTOVER' || input.operation === 'RECONCILE' || fence !== null) &&
        (fence === null ||
          fence.snapshotVersion !== plan.partySnapshotVersion ||
          fence.migrationPlanRef !== plan.planId)
      ) {
        return yield* new CustomerProfileIcoMigrationRejected({
          code: 'AUTHORITY_NOT_FENCED',
          reason: 'Current Party authority is not fenced for this exact migration plan',
        });
      }
      const [row] = yield* transaction
        .invoke(applyRoutine, [
          scope.principalId,
          invocationId,
          DateTime.formatIso(yield* DateTime.now),
          {
            expectedAuthorityRevision: input.expectedAuthorityRevision ?? null,
            fence,
            operation: input.operation,
            plan,
          },
        ])
        .pipe(Effect.mapError(unavailable));
      if (row?.outcome !== 'APPLIED') {
        const supported = ['STALE_PLAN', 'AUTHORITY_NOT_FENCED'] as const;
        const code = supported.find((candidate) => candidate === row?.outcome) ?? 'PLAN_CONFLICT';
        return yield* new CustomerProfileIcoMigrationRejected({
          code,
          reason: 'The migration conflicts with current owner evidence',
        });
      }
      const result = yield* Schema.decodeUnknownEffect(MigrateCustomerProfileIcoResultSchema)(row.result).pipe(
        Effect.mapError(unavailable),
      );
      const evidence = yield* Schema.decodeUnknownEffect(MigrationApplyEvidenceSchema)(row.result).pipe(
        Effect.mapError(unavailable),
      );
      return { ...evidence, result, targetInventoryCount };
    }),
    report: (input) => prepare(input, 'report').pipe(Effect.map(({ plan }) => plan)),
  };
});
