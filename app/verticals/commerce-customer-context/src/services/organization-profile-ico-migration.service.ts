import { lockProfileIcoCorrelation } from '../persistence/profile-ico-correlation-fence.ts';
import { defineScopedRoutine, requireModuleOperation } from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import {
  CommerceLegacyIcoInventory,
  profileIcoCorrelationOptions,
  profileIcoInventoryOptions,
} from '../integrations/party-legacy-ico-inventory.ts';
import { CommerceOrganizationProfileIcoEligibility } from '../integrations/organization-profile-ico-eligibility.ts';
import { OrganizationProfileIcoRejected } from '../../shared/domain/organization-profile-ico.ts';
import {
  CustomerProfileIcoMigrationTargetSchema,
  ProfileIcoMigrationOrganizationAuthoritySchema,
  classifyCustomerProfileIcoMigrationRecords,
  customerProfileIcoMigrationInventoryVersion,
  observeIcoCorrelationCoverage,
  requiresIcoCorrelationCoverage,
} from '../../shared/domain/customer-profile-ico-migration.ts';
import {
  ORGANIZATION_ICO_MIGRATION_PROJECTION,
  OrganizationProfileIcoMigrationLegacySchema,
  OrganizationProfileIcoMigrationPreparedPlanSchema,
  projectOrganizationProfileIcoMigration,
} from '../../shared/domain/organization-profile-ico-migration.ts';
import type {
  OrganizationProfileIcoMigrationInput,
  OrganizationProfileIcoMigrationReport,
  MigrateOrganizationCustomerProfileIcoPayload,
} from '../../shared/domain/organization-profile-ico-migration.ts';

const inventoryRoutine = defineScopedRoutine({
  name: 'profile_ico_target_inventory',
  ownerModuleKey: 'commerce.customer-context',
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
  ownerModuleKey: 'commerce.customer-context',
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
const applyResultSchema = Schema.Struct({
  authorityReadCount: Schema.Int,
  ledgerReads: Schema.Array(
    Schema.Struct({ profileRef: CustomerProfileIcoMigrationTargetSchema.fields.profileRef, resultCount: Schema.Int }),
  ),
  partyFenceId: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
  phase: Schema.Literals(['STAGING', 'COMMERCE']),
  plan: OrganizationProfileIcoMigrationPreparedPlanSchema,
  replayed: Schema.Boolean,
});
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new OrganizationProfileIcoRejected({
      code: 'PERSISTENCE_UNAVAILABLE',
      reason: 'Complete native organization ICO migration evidence is unavailable',
    }),
    'cause',
    { value: cause },
  );
const requiresFullAuthority = (cause: unknown) =>
  Object.defineProperty(
    new OrganizationProfileIcoRejected({
      code: 'PERSONAL_INVENTORY_REQUIRES_FULL_AUTHORITY',
      reason:
        'Every inventory assertion and target must have current bounded organization authority before this company-only migration',
    }),
    'cause',
    { value: cause },
  );
const hasCommitCoverage = (coverage: ReturnType<typeof observeIcoCorrelationCoverage>, fenceHeld = false) =>
  coverage?.complete === true && fenceHeld;

export interface OrganizationProfileIcoMigrationServices {
  readonly apply: (
    input: MigrateOrganizationCustomerProfileIcoPayload,
    invocationId: string,
  ) => Effect.Effect<
    {
      readonly authorityReadCount: number;
      readonly ledgerReads: typeof applyResultSchema.Type.ledgerReads;
      readonly result: Omit<typeof applyResultSchema.Type, 'authorityReadCount' | 'ledgerReads' | 'plan'> & {
        readonly plan: OrganizationProfileIcoMigrationReport;
      };
      readonly targetInventoryCount: number;
    },
    OrganizationProfileIcoRejected
  >;
  readonly report: (
    input: OrganizationProfileIcoMigrationInput,
  ) => Effect.Effect<OrganizationProfileIcoMigrationReport, OrganizationProfileIcoRejected>;
}
export const organizationProfileIcoMigrationServices: ReadServiceFactory<
  OrganizationProfileIcoMigrationServices,
  CommerceLegacyIcoInventory | CommerceOrganizationProfileIcoEligibility
> = Effect.fn('OrganizationProfileIcoMigration.services')(function* services(transaction, scope) {
  const party = yield* CommerceLegacyIcoInventory;
  const eligibility = yield* CommerceOrganizationProfileIcoEligibility;
  const prepare = Effect.fn('OrganizationProfileIcoMigration.prepare')(function* prepare(
    input: OrganizationProfileIcoMigrationInput,
    operation: 'migrate' | 'migration-report',
  ) {
    const prefix = `commerce.customer-context.requirement.organization-profile-ico-${operation}`;
    yield* requireModuleOperation(`${prefix}-inventory`).pipe(Effect.mapError(unavailable));
    yield* requireModuleOperation(`${prefix}-counterparty`).pipe(Effect.mapError(unavailable));
    const [targetRow] = yield* transaction.invoke(inventoryRoutine, []).pipe(Effect.mapError(unavailable));
    if (targetRow === undefined) {
      return yield* unavailable(targetRow);
    }
    if (targetRow.result.targets.some((target) => target.profileRef.kind !== 'COUNTERPARTY')) {
      return yield* requiresFullAuthority(targetRow.result.targets);
    }
    const requireWitness = requiresIcoCorrelationCoverage(targetRow.result.targets, scope.legalEntityId);
    const [commitFence] =
      operation === 'migrate' && requireWitness
        ? yield* transaction.invoke(lockProfileIcoCorrelation, []).pipe(Effect.mapError(unavailable))
        : [];
    if (operation === 'migrate' && requireWitness && commitFence === undefined) {
      return yield* unavailable(commitFence);
    }
    const inventory = yield* party
      .read(
        scope,
        profileIcoInventoryOptions(
          {
            operationRequirementKey: `${prefix}-inventory`,
            projection: ORGANIZATION_ICO_MIGRATION_PROJECTION,
          },
          scope.legalEntityId,
          input.correlationWitnesses,
          requireWitness,
          commitFence?.challenge,
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const assertions = yield* Schema.decodeUnknownEffect(Schema.Array(OrganizationProfileIcoMigrationLegacySchema), {
      onExcessProperty: 'error',
    })(inventory.assertions).pipe(Effect.mapError(requiresFullAuthority));
    if (
      assertions.some(
        (record) =>
          record.provenance.ownerReceiptRef.resourceId !== record.assertionRef.resourceId ||
          record.provenance.ownerReceiptRef.tenantId !== scope.tenantId,
      )
    ) {
      return yield* requiresFullAuthority(inventory);
    }
    const targets = yield* Effect.forEach(
      targetRow.result.targets.filter((target) => target.legalEntityId === scope.legalEntityId),
      Effect.fn('OrganizationProfileIcoMigration.target')(function* target(record) {
        if (record.profileRef.kind !== 'COUNTERPARTY') {
          return yield* requiresFullAuthority(record.profileRef);
        }
        const { kind: _kind, ...profileRef } = record.profileRef;
        const authority = yield* eligibility.check(
          scope,
          { operation: 'customer-profile-ico.migrate', profileRef },
          `${prefix}-privacy`,
        );
        const current = yield* party.correlate(
          scope,
          {
            moduleId: 'party.registry',
            resourceId: record.subjectResourceId,
            resourceType: 'party.registry.counterparty',
            tenantId: scope.tenantId,
          },
          profileIcoCorrelationOptions(
            {
              operationRequirementKey: `${prefix}-counterparty`,
              organizationOnly: true,
            },
            requireWitness,
          ),
        );
        if (Option.isNone(current) || current.value.organizationProof === undefined) {
          return yield* new OrganizationProfileIcoRejected({
            code: 'PROFILE_NOT_ADMISSIBLE',
            reason: 'Current native organization and customer-role correlation is unavailable',
          });
        }
        if (
          current.value.partyRef.resourceId !== authority.partyRef.resourceId ||
          current.value.organizationProof.partyRevision !== authority.partyRevision ||
          authority.profileRevision !== record.revision
        ) {
          return yield* new OrganizationProfileIcoRejected({
            code: 'STALE_PLAN',
            reason: 'Native organization or profile versions changed during the current observation',
          });
        }
        const organizationIcoAuthority = yield* Schema.decodeUnknownEffect(
          ProfileIcoMigrationOrganizationAuthoritySchema,
        )(authority).pipe(Effect.mapError(unavailable));
        return {
          ...record,
          organizationCorrelation: current.value.organizationProof,
          organizationIcoAuthority,
          partyCorrelation: current.value,
        };
      }),
      { concurrency: 1 },
    );
    const now = DateTime.formatIso(yield* DateTime.now);
    if (input.asOf > now) {
      return yield* new OrganizationProfileIcoRejected({
        code: 'STALE_PLAN',
        reason: 'Migration cannot promote future facts',
      });
    }
    const coverage = observeIcoCorrelationCoverage(
      inventory,
      targetRow.result.targets,
      targets,
      scope.legalEntityId,
      input.correlationWitnesses ?? [],
    );
    const records = classifyCustomerProfileIcoMigrationRecords(
      input,
      { assertions },
      targets,
      {
        authorityRevision: targetRow.result.authorityRevision ?? null,
        legalEntityId: scope.legalEntityId ?? '',
        observedAt: now,
      },
      coverage,
    );
    if (commitFence !== undefined && !hasCommitCoverage(coverage, inventory.commitFenceHeld)) {
      return yield* new OrganizationProfileIcoRejected({
        code: 'PROFILE_NOT_ADMISSIBLE',
        reason: 'Current owner correlation proof is required for every Counterparty home',
      });
    }
    const candidate = {
      asOf: input.asOf,
      authorityRevision: targetRow.result.authorityRevision ?? null,
      nativeTargetInventoryVersion: targetRow.result.version,
      partySnapshotVersion: inventory.snapshotVersion,
      planId: input.planId,
      projection: ORGANIZATION_ICO_MIGRATION_PROJECTION,
      records,
      sourceContext: input.sourceContext,
      targetInventoryVersion: customerProfileIcoMigrationInventoryVersion(
        targetRow.result.version,
        targets,
        records,
        coverage?.version,
      ),
      tenantId: scope.tenantId,
      version: 1,
    };
    if (coverage?.version !== undefined) {
      Object.assign(candidate, { correlationCoverageVersion: coverage.version });
    }
    const plan = yield* Schema.decodeUnknownEffect(OrganizationProfileIcoMigrationPreparedPlanSchema)(candidate).pipe(
      Effect.mapError(unavailable),
    );
    return { commitFence, coverage, inventory, plan, targetInventoryCount: targetRow.result.targets.length };
  });
  return {
    apply: Effect.fn('OrganizationProfileIcoMigration.apply')(function* apply(input, invocationId) {
      const { commitFence, inventory, plan, targetInventoryCount } = yield* prepare(input, 'migrate');
      if (
        plan.partySnapshotVersion !== input.expectedPartySnapshotVersion ||
        plan.targetInventoryVersion !== input.expectedTargetInventoryVersion
      ) {
        return yield* new OrganizationProfileIcoRejected({
          code: 'STALE_PLAN',
          reason: 'A complete owner inventory or native organization correlation changed after the approved report',
        });
      }
      const fence = inventory.authority.kind === 'COMMERCE_FENCED' ? inventory.authority.proof : null;
      if (
        (input.operation === 'CUTOVER' || input.operation === 'RECONCILE' || fence !== null) &&
        (fence === null ||
          fence.snapshotVersion !== plan.partySnapshotVersion ||
          fence.migrationPlanRef !== plan.planId)
      ) {
        return yield* new OrganizationProfileIcoRejected({
          code: 'AUTHORITY_NOT_FENCED',
          reason: 'Party authority is not fenced for this exact complete organization plan',
        });
      }
      const [row] = yield* transaction
        .invoke(applyRoutine, [
          scope.principalId,
          invocationId,
          DateTime.formatIso(yield* DateTime.now),
          {
            commitFenceChallenge: commitFence?.challenge ?? null,
            expectedAuthorityRevision: input.expectedAuthorityRevision ?? null,
            fence,
            operation: input.operation,
            plan,
          },
        ])
        .pipe(Effect.mapError(unavailable));
      if (row?.outcome !== 'APPLIED') {
        return yield* new OrganizationProfileIcoRejected({
          code:
            row?.outcome === 'STALE_PLAN' || row?.outcome === 'AUTHORITY_NOT_FENCED' ? row.outcome : 'PLAN_CONFLICT',
          reason: 'The organization migration conflicts with current owner evidence',
        });
      }
      const accepted = yield* Schema.decodeUnknownEffect(applyResultSchema)(row.result).pipe(
        Effect.mapError(unavailable),
      );
      const publicPlan = yield* projectOrganizationProfileIcoMigration(accepted.plan).pipe(
        Effect.mapError(unavailable),
      );
      return {
        authorityReadCount: accepted.authorityReadCount,
        ledgerReads: accepted.ledgerReads,
        result: {
          partyFenceId: accepted.partyFenceId,
          phase: accepted.phase,
          plan: publicPlan,
          replayed: accepted.replayed,
        },
        targetInventoryCount,
      };
    }),
    report: (input) =>
      prepare(input, 'migration-report').pipe(
        Effect.flatMap(({ coverage, plan }) =>
          projectOrganizationProfileIcoMigration(plan).pipe(
            Effect.mapError(unavailable),
            Effect.map((report) =>
              coverage === undefined ? report : { ...report, homeCorrelationWitnesses: coverage.homeWitnesses },
            ),
          ),
        ),
      ),
  };
});
