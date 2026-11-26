// @ontos-action-owner commerce.inventory
// @ontos-action-slug grant-staff-stock-source-authority
import type { ActionHandlerContext, OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import {
  GrantStaffStockSourceAuthorityErrorSchema,
  GrantStaffStockSourceAuthorityPayloadSchema,
  GrantStaffStockSourceAuthorityResultSchema,
  StaffStockSourceAuthorityRejected,
  StaffStockSourceAuthorityUnavailable,
} from '../../shared/actions/grant-staff-stock-source-authority.ts';
import type {
  GrantStaffStockSourceAuthorityPayload,
  GrantStaffStockSourceAuthorityResult,
} from '../../shared/actions/grant-staff-stock-source-authority.ts';
import {
  InventorySourceAssertionProposalSchema,
  OwnerOrderKeyEvidenceSchema,
  SourceRevisionOrderingEvidenceSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import type {
  InventorySourceAssertionProposal,
  InventorySourceOrderingEvidence,
} from '../../shared/domain/inventory-source-assertion.ts';
import { compareInventorySourceOrdering } from '../../shared/domain/inventory-source-ordering.ts';
import { PhysicalStockEffectIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import { inventoryBackendConfigurationPersistenceForScope } from '../persistence/inventory-backend-configuration-repository.ts';
import { inventorySourceImportLedger } from '../persistence/inventory-source-import-ledger-table.ts';
import { inventoryPhysicalStockEffects } from '../persistence/physical-stock-effect-table.ts';
import { stockPositionPersistenceForScope } from '../persistence/stock-position-repository.ts';

export {
  GrantStaffStockSourceAuthorityPayloadSchema,
  GrantStaffStockSourceAuthorityResultSchema,
} from '../../shared/actions/grant-staff-stock-source-authority.ts';

const ACTION_KEY = 'commerce.inventory.grant-staff-stock-source-authority';
const MODULE_KEY = 'commerce.inventory';
const domainEvents = {} as const;

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const rejected = (reason: string) =>
  new StaffStockSourceAuthorityRejected({ code: 'staff_stock_source_authority_rejected', reason });
const unavailable = (cause: unknown) => {
  const failure = new StaffStockSourceAuthorityUnavailable({
    code: 'staff_stock_source_authority_unavailable',
    reason: 'Inventory could not read the source evidence of this Stock Position',
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const isRevision = Schema.is(SourceRevisionOrderingEvidenceSchema);
const isOwnerKey = Schema.is(OwnerOrderKeyEvidenceSchema);

/** The ordering evidence just after every accepted one of the stream; undefined when none can be stated. */
const nextOrdering = (
  accepted: readonly InventorySourceAssertionProposal[],
): InventorySourceOrderingEvidence | undefined => {
  let revision = 0n;
  let ownerKey = '';
  let revisions = 0;
  let ownerKeys = 0;
  for (const { orderingEvidence } of accepted) {
    if (isRevision(orderingEvidence) && /^\d+$/u.test(orderingEvidence.revision)) {
      revisions += 1;
      const value = BigInt(orderingEvidence.revision);
      revision = value > revision ? value : revision;
    } else if (isOwnerKey(orderingEvidence)) {
      ownerKeys += 1;
      ownerKey = orderingEvidence.key > ownerKey ? orderingEvidence.key : ownerKey;
    }
  }
  if (revisions === accepted.length) {
    return { _tag: 'SOURCE_REVISION', revision: (revision + 1n).toString() };
  }
  if (ownerKeys === accepted.length && ownerKey.length < 300) {
    return { _tag: 'OWNER_ORDER_KEY', key: `${ownerKey}~` };
  }
  return undefined;
};

export interface StaffStockSourceAuthorityOperations {
  readonly grant: (
    payload: GrantStaffStockSourceAuthorityPayload,
  ) => Effect.Effect<
    GrantStaffStockSourceAuthorityResult,
    StaffStockSourceAuthorityRejected | StaffStockSourceAuthorityUnavailable
  >;
}

const staffStockSourceAuthority = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): StaffStockSourceAuthorityOperations => ({
  grant: Effect.fn('GrantStaffStockSourceAuthority.grant')(function* grant(payload) {
    const selected = yield* inventoryBackendConfigurationPersistenceForScope(transaction, scope)
      .findCurrent(payload.customerConfigurationId)
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(selected)) {
      return yield* rejected('No Inventory Backend is selected for this Customer Configuration');
    }
    const configuration = selected.value;
    if (configuration.selection.backend !== 'external_business_system') {
      return yield* rejected('This Customer Configuration is held by the OntOS WMS; use a stock receipt or issue');
    }
    const position = yield* stockPositionPersistenceForScope(transaction, scope)
      .read(payload.positionRef)
      .pipe(Effect.mapError(unavailable));
    if (
      Option.isNone(position) ||
      position.value.scope.customerConfigurationId !== payload.customerConfigurationId ||
      position.value.onHand.ownerConfigurationRef.resourceId !== configuration.configurationId
    ) {
      return yield* rejected('The Stock Position is not held by the selected External Business System');
    }
    const issuer = {
      backendId: configuration.selection.backendId,
      backendKind: configuration.selection.backend,
    };
    const rows = yield* transaction
      .select({ proposal: inventorySourceImportLedger.proposalJson })
      .from(inventorySourceImportLedger)
      .where(
        and(
          eq(inventorySourceImportLedger.tenantId, scope.tenantId),
          eq(inventorySourceImportLedger.customerConfigurationId, payload.customerConfigurationId),
          eq(inventorySourceImportLedger.issuerBackendKind, issuer.backendKind),
          eq(inventorySourceImportLedger.issuerBackendId, issuer.backendId),
          eq(inventorySourceImportLedger.factMeaning, 'ABSOLUTE_PHYSICAL_ON_HAND'),
          eq(inventorySourceImportLedger.positionId, payload.positionRef.resourceId),
          eq(inventorySourceImportLedger.status, 'ACCEPTED'),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const accepted = yield* Schema.decodeUnknownEffect(Schema.Array(InventorySourceAssertionProposalSchema))(
      rows.map(({ proposal }) => proposal),
    ).pipe(Effect.mapError(unavailable));
    const [first, ...others] = accepted;
    if (first === undefined) {
      return yield* rejected('The source has not reported this Stock Position yet, so its ERP keys are unknown');
    }
    let latest = first;
    for (const candidate of others) {
      if (compareInventorySourceOrdering(candidate.orderingEvidence, latest.orderingEvidence) === 'NEWER') {
        latest = candidate;
      }
    }
    const orderingEvidence = nextOrdering(accepted);
    if (orderingEvidence === undefined) {
      return yield* rejected('The source ordering evidence of this Stock Position cannot be continued');
    }
    const effects = yield* transaction
      .select({ effectId: inventoryPhysicalStockEffects.effectId })
      .from(inventoryPhysicalStockEffects)
      .where(
        and(
          eq(inventoryPhysicalStockEffects.tenantId, scope.tenantId),
          eq(inventoryPhysicalStockEffects.positionId, payload.positionRef.resourceId),
          eq(inventoryPhysicalStockEffects.state, 'APPLIED'),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const coverageEffectIds = yield* Schema.decodeUnknownEffect(Schema.Array(PhysicalStockEffectIdSchema))(
      effects.map(({ effectId }) => effectId),
    ).pipe(Effect.mapError(unavailable));
    const result: GrantStaffStockSourceAuthorityResult = {
      coverageEffectIds,
      issuer: latest.issuer,
      itemExternalKey: latest.itemExternalKey,
      locationExternalKey: latest.locationExternalKey,
      orderingEvidence,
      selectedAt: configuration.selectedAt,
    };
    return result;
  }),
});

export const handleGrantStaffStockSourceAuthority = Effect.fn('GrantStaffStockSourceAuthorityAction.handle')(
  function* handle(
    payload: GrantStaffStockSourceAuthorityPayload,
    context: ActionHandlerContext<typeof domainEvents, StaffStockSourceAuthorityOperations>,
  ) {
    if (payload.positionRef.tenantId !== context.scope.tenantId) {
      return yield* rejected('The Stock Position must belong to the trusted Tenant');
    }
    const result = yield* context.services.grant(payload);
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: `inventory-staff-stock-source-authority:${payload.positionRef.resourceId}`,
      resultCount: 1,
      servingModuleKey: MODULE_KEY,
      targetModuleKey: MODULE_KEY,
      targetResourceId: payload.positionRef.resourceId,
      targetResourceType: 'commerce.inventory.stock-position',
    });
    return result;
  },
);

export const grantStaffStockSourceAuthorityAction = defineAction(
  {
    accessDeclaration: {
      key: 'commerce.inventory.staff-stock-source-authority.grant',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'source-evidence', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'commerce.inventory.grant-staff-stock-source-authority.access.v1',
    },
    actionKey: ACTION_KEY,
    auditProfile: 'standard',
    domainErrorSchema: GrantStaffStockSourceAuthorityErrorSchema,
    domainEvents,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: ACTION_KEY,
      moduleKey: MODULE_KEY,
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: MODULE_KEY,
    payloadSchema: GrantStaffStockSourceAuthorityPayloadSchema,
    policies: [],
    resultSchema: GrantStaffStockSourceAuthorityResultSchema,
    schemaVersion: '1',
  },
  handleGrantStaffStockSourceAuthority,
  (transaction, scope) => Effect.succeed(staffStockSourceAuthority(transaction, scope)),
);
