import { Match, Schema } from 'effect';

import { CatalogStockDemandSchema } from './catalog-to-stock-binding.ts';
import type { CatalogStockDemand } from './catalog-to-stock-binding.ts';
import { CatalogToStockBindingResolutionFailure } from './catalog-to-stock-binding-resolution.ts';
import { InventoryBackendCutoverBlockerSchema } from './inventory-backend-cutover.ts';
import { InventoryBackendConfigurationSchema } from './inventory-backend-configuration.ts';
import type { InventoryBackendConfiguration } from './inventory-backend-configuration.ts';
import { ExternalStockKeySchema } from './external-stock-correlation.ts';
import {
  IndeterminateInventorySourceAssertionEvaluationSchema,
  InventorySourceAssertionSchema,
} from './inventory-source-assertion.ts';
import {
  IndeterminateReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
  ReconciliationRequiredReservationCreateEffectSchema,
  ReservationCreateAllocationSchema,
} from './inventory-reservation-create.ts';
import { PhysicalStockEffectIdSchema } from './physical-stock-effect.ts';
import { ReservationAuthorityEffectIdSchema } from './reservation-issuer-failure-fields.ts';
import { StockQuantitySchema, compareExactStockQuantityAmounts } from './stock-position.ts';
import { OrderCommitmentAttemptIdSchema } from '../inventory-launch-scope.ts';
import { CommitmentProtectionRefSchema } from '../resources/commitment-protection.ts';
import { ImportedCommittedObligationRefSchema } from '../resources/imported-committed-obligation.ts';
import { InventoryReservationRefSchema } from '../resources/inventory-reservation.ts';
import { ReservationConfirmationRefSchema } from '../resources/reservation-confirmation.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

export const inventoryOperationalProblemKinds = [
  'BACKEND_CONFIGURATION_INVALID',
  'BACKEND_CONFIGURATION_MISMATCH',
  'STOCK_EVIDENCE_STALE',
  'STOCK_EVIDENCE_MISSING',
  'STOCK_EVIDENCE_INDETERMINATE',
  'STOCK_EVIDENCE_CONFLICTING',
  'STOCK_CORRECTION_EVIDENCE_REQUIRED',
  'BINDING_MISSING',
  'BINDING_CONFLICTING',
  'BINDING_INCOMPATIBLE',
  'EXTERNAL_ITEM_CORRELATION_UNRESOLVED',
  'EXTERNAL_ITEM_CORRELATION_AMBIGUOUS',
  'EXTERNAL_LOCATION_CORRELATION_UNRESOLVED',
  'EXTERNAL_LOCATION_CORRELATION_AMBIGUOUS',
  'INVALID_QUANTITY',
  'INCOMPATIBLE_UNIT',
  'SOURCE_COVERAGE_UNCERTAIN',
  'CONFIRMATION_AT_RISK',
  'CONFIRMATION_REVOKED',
  'CONFIRMATION_EXPIRED',
  'CONFIRMATION_UNVERIFIABLE',
  'PROTECTION_AT_RISK',
  'PROTECTION_PROTECTED',
  'PROTECTION_LATE_ESTABLISHMENT_PROVEN',
  'PROTECTION_ESTABLISHMENT_INDETERMINATE',
  'CREATE_INDETERMINATE',
  'RELEASE_INDETERMINATE',
  'PHYSICAL_MUTATION_INDETERMINATE',
  'PARTIAL_CREATE_HOLD',
  'POSSIBLE_PARTIAL_CREATE_HOLD',
  'PRE_COMMIT_COMPENSATION_DEBT',
  'POST_COMMIT_OBLIGATION_DEBT',
  'IMPORTED_COMMITTED_ORIGIN',
  'UNRESOLVED_LEGACY_HOLD',
  'CUTOVER_BLOCKER',
] as const;

export const InventoryOperationalProblemKindSchema = Schema.Literals(inventoryOperationalProblemKinds);
export type InventoryOperationalProblemKind = typeof InventoryOperationalProblemKindSchema.Type;

export const InventoryOperationalActualOwnerSchema = Schema.Literals([
  'CATALOG_TO_STOCK_BINDING_OWNER',
  'INVENTORY_CONFIGURATION_OWNER',
  'INVENTORY_INPUT_BOUNDARY',
  'INVENTORY_OBLIGATION_OWNER',
  'ORIGINAL_RESERVATION_AUTHORITY',
  'SELECTED_INVENTORY_BACKEND',
]);

export const InventoryOperationalSafeNextActionSchema = Schema.Literals([
  'ACQUIRE_OWNER_EVIDENCE',
  'BLOCK_AND_ESCALATE',
  'CORRECT_WITH_CURRENT_OWNER_EVIDENCE',
  'RECOVER_ORIGINAL_EFFECT',
  'RECONCILE',
  'RECONCILE_SOURCE_COVERAGE',
  'RECONCILE_WITHOUT_RELEASE',
  'REPAIR_CONFIGURATION',
  'REPAIR_CORRELATION',
  'REPAIR_INPUT',
  'REPAIR_OBLIGATION_WITHOUT_ORDER_ROLLBACK',
  'RESOLVE_CUTOVER_BLOCKERS',
  'RESOLVE_LEGACY_HOLD',
  'RESOLVE_PRE_COMMIT_DEBT',
  'RUN_BINDING_OWNER_LIFECYCLE',
  'PRESERVE_PROTECTION_FENCE',
  'START_NEW_ATTEMPT_AFTER_SAFE_PREDECESSOR_RESOLUTION',
]);

export const InventoryOperationalProhibitedActionSchema = Schema.Literals([
  'BACKEND_SWITCH_AS_RECOVERY',
  'INFER_STOCK_ITEM',
  'MANUAL_ON_HAND_ARITHMETIC',
  'PRIVATE_OWNER_MUTATION',
  'RELEASE_AT_RISK_PROTECTION',
  'REPLAY_UNRESOLVED_EFFECT_AS_FRESH',
  'RETARGET_COMMITTED_OBLIGATION',
  'REUSE_UNRESOLVED_HOLD',
  'ROLLBACK_COMMITTED_ORDER',
]);

export const InventoryOperationalRecoveryPolicySchema = Schema.Struct({
  actualOwner: InventoryOperationalActualOwnerSchema,
  backendSwitchingAllowed: Schema.Literal(false),
  impact: Schema.Literals([
    'BLOCKS_CUTOVER',
    'BLOCKS_READINESS',
    'BLOCKS_STOCK_TRUTH',
    'PRESERVES_COMMITTED_OBLIGATION',
    'PRESERVES_EXACT_CONSTRAINED_EFFECT',
    'PRESERVES_PROTECTION_FENCE',
    'PRESERVES_POSSIBLE_PROTECTION_FENCE',
    'PRESERVES_POSSIBLE_STOCK_EFFECT',
    'REQUIRES_INPUT_REPAIR',
  ]),
  permissionTransfersFactOwnership: Schema.Literal(false),
  prohibitedActions: Schema.Array(InventoryOperationalProhibitedActionSchema).check(Schema.isMinLength(1)),
  supportedSafeNextAction: InventoryOperationalSafeNextActionSchema,
  truth: Schema.Literals(['PROVEN', 'UNKNOWN']),
  unresolvedEffectMayBeReplayedAsFresh: Schema.Literal(false),
});
export type InventoryOperationalRecoveryPolicy = typeof InventoryOperationalRecoveryPolicySchema.Type;

const universalProhibitions = [
  'BACKEND_SWITCH_AS_RECOVERY',
  'PRIVATE_OWNER_MUTATION',
  'REPLAY_UNRESOLVED_EFFECT_AS_FRESH',
] as const;

const policy = (
  actualOwner: InventoryOperationalRecoveryPolicy['actualOwner'],
  truth: InventoryOperationalRecoveryPolicy['truth'],
  impact: InventoryOperationalRecoveryPolicy['impact'],
  supportedSafeNextAction: InventoryOperationalRecoveryPolicy['supportedSafeNextAction'],
  additionalProhibitions: readonly (typeof InventoryOperationalProhibitedActionSchema.Type)[] = [],
): InventoryOperationalRecoveryPolicy => ({
  actualOwner,
  backendSwitchingAllowed: false,
  impact,
  permissionTransfersFactOwnership: false,
  prohibitedActions: [...universalProhibitions, ...additionalProhibitions],
  supportedSafeNextAction,
  truth,
  unresolvedEffectMayBeReplayedAsFresh: false,
});

const configurationPolicy = policy(
  'INVENTORY_CONFIGURATION_OWNER',
  'PROVEN',
  'BLOCKS_READINESS',
  'REPAIR_CONFIGURATION',
);
const uncertainEvidencePolicy = policy(
  'SELECTED_INVENTORY_BACKEND',
  'UNKNOWN',
  'BLOCKS_STOCK_TRUTH',
  'ACQUIRE_OWNER_EVIDENCE',
  ['MANUAL_ON_HAND_ARITHMETIC'],
);
const bindingPolicy = policy(
  'CATALOG_TO_STOCK_BINDING_OWNER',
  'PROVEN',
  'BLOCKS_READINESS',
  'RUN_BINDING_OWNER_LIFECYCLE',
  ['INFER_STOCK_ITEM'],
);
const correlationPolicy = policy('SELECTED_INVENTORY_BACKEND', 'UNKNOWN', 'BLOCKS_STOCK_TRUTH', 'REPAIR_CORRELATION');
const inputPolicy = policy('INVENTORY_INPUT_BOUNDARY', 'PROVEN', 'REQUIRES_INPUT_REPAIR', 'REPAIR_INPUT');
const effectPolicy = policy(
  'ORIGINAL_RESERVATION_AUTHORITY',
  'UNKNOWN',
  'PRESERVES_POSSIBLE_STOCK_EFFECT',
  'RECOVER_ORIGINAL_EFFECT',
  ['REUSE_UNRESOLVED_HOLD'],
);
const physicalEffectPolicy = policy(
  'SELECTED_INVENTORY_BACKEND',
  'UNKNOWN',
  'PRESERVES_POSSIBLE_STOCK_EFFECT',
  'RECOVER_ORIGINAL_EFFECT',
  ['MANUAL_ON_HAND_ARITHMETIC', 'REUSE_UNRESOLVED_HOLD'],
);
const terminalConfirmationPolicy = policy(
  'ORIGINAL_RESERVATION_AUTHORITY',
  'PROVEN',
  'BLOCKS_READINESS',
  'START_NEW_ATTEMPT_AFTER_SAFE_PREDECESSOR_RESOLUTION',
  ['RELEASE_AT_RISK_PROTECTION', 'REUSE_UNRESOLVED_HOLD'],
);
const protectionAtRiskPolicy = policy(
  'ORIGINAL_RESERVATION_AUTHORITY',
  'PROVEN',
  'PRESERVES_POSSIBLE_STOCK_EFFECT',
  'RECONCILE_WITHOUT_RELEASE',
  ['RELEASE_AT_RISK_PROTECTION'],
);
const protectionFencePolicy = policy(
  'ORIGINAL_RESERVATION_AUTHORITY',
  'PROVEN',
  'PRESERVES_PROTECTION_FENCE',
  'PRESERVE_PROTECTION_FENCE',
  ['RELEASE_AT_RISK_PROTECTION'],
);
const indeterminateProtectionPolicy = policy(
  'ORIGINAL_RESERVATION_AUTHORITY',
  'UNKNOWN',
  'PRESERVES_POSSIBLE_PROTECTION_FENCE',
  'RECOVER_ORIGINAL_EFFECT',
  ['RELEASE_AT_RISK_PROTECTION', 'REUSE_UNRESOLVED_HOLD'],
);
const provenPartialCreatePolicy = policy(
  'ORIGINAL_RESERVATION_AUTHORITY',
  'PROVEN',
  'PRESERVES_EXACT_CONSTRAINED_EFFECT',
  'RESOLVE_PRE_COMMIT_DEBT',
  ['REUSE_UNRESOLVED_HOLD'],
);
const committedObligationPolicy = policy(
  'INVENTORY_OBLIGATION_OWNER',
  'PROVEN',
  'PRESERVES_COMMITTED_OBLIGATION',
  'REPAIR_OBLIGATION_WITHOUT_ORDER_ROLLBACK',
  ['RETARGET_COMMITTED_OBLIGATION', 'ROLLBACK_COMMITTED_ORDER'],
);

const policies = {
  BACKEND_CONFIGURATION_INVALID: configurationPolicy,
  BACKEND_CONFIGURATION_MISMATCH: configurationPolicy,
  BINDING_CONFLICTING: bindingPolicy,
  BINDING_INCOMPATIBLE: bindingPolicy,
  BINDING_MISSING: bindingPolicy,
  CONFIRMATION_AT_RISK: policy('ORIGINAL_RESERVATION_AUTHORITY', 'PROVEN', 'BLOCKS_READINESS', 'RECONCILE'),
  CONFIRMATION_EXPIRED: terminalConfirmationPolicy,
  CONFIRMATION_REVOKED: terminalConfirmationPolicy,
  CONFIRMATION_UNVERIFIABLE: policy(
    'ORIGINAL_RESERVATION_AUTHORITY',
    'UNKNOWN',
    'BLOCKS_READINESS',
    'ACQUIRE_OWNER_EVIDENCE',
  ),
  CREATE_INDETERMINATE: effectPolicy,
  CUTOVER_BLOCKER: policy('INVENTORY_CONFIGURATION_OWNER', 'PROVEN', 'BLOCKS_CUTOVER', 'RESOLVE_CUTOVER_BLOCKERS'),
  EXTERNAL_ITEM_CORRELATION_AMBIGUOUS: correlationPolicy,
  EXTERNAL_ITEM_CORRELATION_UNRESOLVED: correlationPolicy,
  EXTERNAL_LOCATION_CORRELATION_AMBIGUOUS: correlationPolicy,
  EXTERNAL_LOCATION_CORRELATION_UNRESOLVED: correlationPolicy,
  IMPORTED_COMMITTED_ORIGIN: policy(
    'INVENTORY_OBLIGATION_OWNER',
    'PROVEN',
    'PRESERVES_COMMITTED_OBLIGATION',
    'RECONCILE',
    ['RETARGET_COMMITTED_OBLIGATION', 'ROLLBACK_COMMITTED_ORDER'],
  ),
  INCOMPATIBLE_UNIT: inputPolicy,
  INVALID_QUANTITY: inputPolicy,
  PARTIAL_CREATE_HOLD: provenPartialCreatePolicy,
  PHYSICAL_MUTATION_INDETERMINATE: physicalEffectPolicy,
  POSSIBLE_PARTIAL_CREATE_HOLD: effectPolicy,
  POST_COMMIT_OBLIGATION_DEBT: committedObligationPolicy,
  PRE_COMMIT_COMPENSATION_DEBT: policy(
    'ORIGINAL_RESERVATION_AUTHORITY',
    'UNKNOWN',
    'PRESERVES_POSSIBLE_STOCK_EFFECT',
    'RESOLVE_PRE_COMMIT_DEBT',
    ['REUSE_UNRESOLVED_HOLD'],
  ),
  PROTECTION_AT_RISK: protectionAtRiskPolicy,
  PROTECTION_ESTABLISHMENT_INDETERMINATE: indeterminateProtectionPolicy,
  PROTECTION_LATE_ESTABLISHMENT_PROVEN: protectionFencePolicy,
  PROTECTION_PROTECTED: protectionFencePolicy,
  RELEASE_INDETERMINATE: effectPolicy,
  SOURCE_COVERAGE_UNCERTAIN: policy(
    'SELECTED_INVENTORY_BACKEND',
    'UNKNOWN',
    'BLOCKS_STOCK_TRUTH',
    'RECONCILE_SOURCE_COVERAGE',
    ['MANUAL_ON_HAND_ARITHMETIC'],
  ),
  STOCK_CORRECTION_EVIDENCE_REQUIRED: policy(
    'SELECTED_INVENTORY_BACKEND',
    'UNKNOWN',
    'BLOCKS_STOCK_TRUTH',
    'CORRECT_WITH_CURRENT_OWNER_EVIDENCE',
    ['MANUAL_ON_HAND_ARITHMETIC'],
  ),
  STOCK_EVIDENCE_CONFLICTING: policy('SELECTED_INVENTORY_BACKEND', 'PROVEN', 'BLOCKS_STOCK_TRUTH', 'RECONCILE', [
    'MANUAL_ON_HAND_ARITHMETIC',
  ]),
  STOCK_EVIDENCE_INDETERMINATE: uncertainEvidencePolicy,
  STOCK_EVIDENCE_MISSING: uncertainEvidencePolicy,
  STOCK_EVIDENCE_STALE: uncertainEvidencePolicy,
  UNRESOLVED_LEGACY_HOLD: policy(
    'INVENTORY_OBLIGATION_OWNER',
    'UNKNOWN',
    'PRESERVES_POSSIBLE_STOCK_EFFECT',
    'RESOLVE_LEGACY_HOLD',
    ['REUSE_UNRESOLVED_HOLD'],
  ),
} satisfies Record<InventoryOperationalProblemKind, InventoryOperationalRecoveryPolicy>;

export const inventoryOperationalPolicyFor = (
  problem: InventoryOperationalProblemKind,
): InventoryOperationalRecoveryPolicy => policies[problem];

const samePolicy = (left: InventoryOperationalRecoveryPolicy, right: InventoryOperationalRecoveryPolicy): boolean =>
  left.actualOwner === right.actualOwner &&
  left.backendSwitchingAllowed === right.backendSwitchingAllowed &&
  left.impact === right.impact &&
  left.permissionTransfersFactOwnership === right.permissionTransfersFactOwnership &&
  left.supportedSafeNextAction === right.supportedSafeNextAction &&
  left.truth === right.truth &&
  left.unresolvedEffectMayBeReplayedAsFresh === right.unresolvedEffectMayBeReplayedAsFresh &&
  left.prohibitedActions.length === right.prohibitedActions.length &&
  left.prohibitedActions.every((action, index) => action === right.prohibitedActions[index]);

const sameTenantId = (left: string, right: string): boolean => left === right;
const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  sameTenantId(left.tenantId, right.tenantId);

const sameBackendConfiguration = (left: InventoryBackendConfiguration, right: InventoryBackendConfiguration): boolean =>
  left.configurationId === right.configurationId &&
  left.customerConfigurationId === right.customerConfigurationId &&
  left.revision === right.revision &&
  left.selectedAt === right.selectedAt &&
  sameTenantId(left.tenantId, right.tenantId) &&
  left.selection.backend === right.selection.backend &&
  left.selection.backendId === right.selection.backendId &&
  left.selection.exactReservationCapability === right.selection.exactReservationCapability &&
  left.selection.stockCorrectionCapability === right.selection.stockCorrectionCapability;

const boundedOperationalReference = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
);
const operationalSubjectScope = {
  customerConfigurationId: InventoryBackendConfigurationSchema.fields.customerConfigurationId,
  tenantId: InventoryBackendConfigurationSchema.fields.tenantId,
} as const;

export const InventoryOperationalSubjectSchema = Schema.Union([
  Schema.TaggedStruct('BACKEND_CONFIGURATION', {
    ...operationalSubjectScope,
    configurationId: InventoryBackendConfigurationSchema.fields.configurationId,
  }),
  Schema.TaggedStruct('CATALOG_DEMAND', { ...operationalSubjectScope, demand: CatalogStockDemandSchema }),
  Schema.TaggedStruct('COMMITTED_OBLIGATION', {
    ...operationalSubjectScope,
    obligationRef: Schema.Union([InventoryReservationRefSchema, ImportedCommittedObligationRefSchema]),
  }),
  Schema.TaggedStruct('CONFIRMATION', {
    ...operationalSubjectScope,
    attemptId: OrderCommitmentAttemptIdSchema,
    confirmationRef: ReservationConfirmationRefSchema,
  }),
  Schema.TaggedStruct('CUTOVER', {
    ...operationalSubjectScope,
    blocker: InventoryBackendCutoverBlockerSchema,
    evaluatedAt: Schema.toEncoded(Schema.DateTimeUtcFromString),
    postCutoverConfigurationId: InventoryBackendConfigurationSchema.fields.configurationId,
    preCutoverConfigurationId: InventoryBackendConfigurationSchema.fields.configurationId,
  }),
  Schema.TaggedStruct('DEMAND_INPUT', { ...operationalSubjectScope, demand: CatalogStockDemandSchema }),
  Schema.TaggedStruct('EXTERNAL_CORRELATION', {
    ...operationalSubjectScope,
    externalKey: ExternalStockKeySchema,
    resolution: Schema.Literals(['AMBIGUOUS', 'UNRESOLVED']),
  }),
  Schema.TaggedStruct('IMPORTED_OBLIGATION', {
    ...operationalSubjectScope,
    obligationRef: ImportedCommittedObligationRefSchema,
  }),
  Schema.TaggedStruct('LEGACY_HOLD', {
    ...operationalSubjectScope,
    holdReference: boundedOperationalReference,
  }),
  Schema.TaggedStruct('PHYSICAL_EFFECT', {
    ...operationalSubjectScope,
    effectId: PhysicalStockEffectIdSchema,
    positionRef: StockPositionRefSchema,
  }),
  Schema.TaggedStruct('PROTECTION', {
    ...operationalSubjectScope,
    attemptId: OrderCommitmentAttemptIdSchema,
    effectId: ReservationAuthorityEffectIdSchema,
    fence: Schema.Literals(['ACTIVE', 'AT_RISK', 'PRESERVE_POSSIBLE_PROTECTION_FENCE']),
    protectionRef: CommitmentProtectionRefSchema,
  }),
  Schema.TaggedStruct('RESERVATION_EFFECT', {
    ...operationalSubjectScope,
    attemptId: OrderCommitmentAttemptIdSchema,
    effectId: ReservationAuthorityEffectIdSchema,
    reservationRef: InventoryReservationRefSchema,
  }),
  Schema.TaggedStruct('SOURCE_ASSERTION', {
    ...operationalSubjectScope,
    assertionId: InventorySourceAssertionSchema.fields.assertionId,
    materialEffectIds: Schema.Array(PhysicalStockEffectIdSchema),
    positionRef: StockPositionRefSchema,
  }),
  Schema.TaggedStruct('STOCK_POSITION', {
    ...operationalSubjectScope,
    positionRef: StockPositionRefSchema,
  }),
]);
export type InventoryOperationalSubject = typeof InventoryOperationalSubjectSchema.Type;

export const InventoryOperationalOwnerIdentitySchema = Schema.Union([
  Schema.TaggedStruct('CATALOG_TO_STOCK_BINDING_OWNER', {
    ...operationalSubjectScope,
    ownerAuthority: Schema.Literal('INVENTORY_BINDING_OWNER'),
  }),
  Schema.TaggedStruct('INVENTORY_CONFIGURATION_OWNER', {
    ...operationalSubjectScope,
    configurationId: InventoryBackendConfigurationSchema.fields.configurationId,
  }),
  Schema.TaggedStruct('INVENTORY_INPUT_BOUNDARY', {
    ...operationalSubjectScope,
    boundary: Schema.Literal('INVENTORY_PUBLIC_INPUT'),
  }),
  Schema.TaggedStruct('INVENTORY_OBLIGATION_OWNER', {
    ...operationalSubjectScope,
    ownerModuleId: Schema.Literal('commerce.inventory'),
  }),
  Schema.TaggedStruct('ORIGINAL_RESERVATION_AUTHORITY', {
    ...operationalSubjectScope,
    backend: InventoryBackendConfigurationSchema.fields.selection.fields.backend,
    backendId: InventoryBackendConfigurationSchema.fields.selection.fields.backendId,
    configurationId: InventoryBackendConfigurationSchema.fields.configurationId,
  }),
  Schema.TaggedStruct('SELECTED_INVENTORY_BACKEND', {
    ...operationalSubjectScope,
    backend: InventoryBackendConfigurationSchema.fields.selection.fields.backend,
    backendId: InventoryBackendConfigurationSchema.fields.selection.fields.backendId,
    configurationId: InventoryBackendConfigurationSchema.fields.configurationId,
  }),
]);
export type InventoryOperationalOwnerIdentity = typeof InventoryOperationalOwnerIdentitySchema.Type;

export const inventoryOperationalSubjectTags = [
  'BACKEND_CONFIGURATION',
  'CATALOG_DEMAND',
  'COMMITTED_OBLIGATION',
  'CONFIRMATION',
  'CUTOVER',
  'DEMAND_INPUT',
  'EXTERNAL_CORRELATION',
  'IMPORTED_OBLIGATION',
  'LEGACY_HOLD',
  'PHYSICAL_EFFECT',
  'PROTECTION',
  'RESERVATION_EFFECT',
  'SOURCE_ASSERTION',
  'STOCK_POSITION',
] as const;
export type InventoryOperationalSubjectTag = (typeof inventoryOperationalSubjectTags)[number];

const subjectTags = {
  BACKEND_CONFIGURATION_INVALID: 'BACKEND_CONFIGURATION',
  BACKEND_CONFIGURATION_MISMATCH: 'BACKEND_CONFIGURATION',
  BINDING_CONFLICTING: 'CATALOG_DEMAND',
  BINDING_INCOMPATIBLE: 'CATALOG_DEMAND',
  BINDING_MISSING: 'CATALOG_DEMAND',
  CONFIRMATION_AT_RISK: 'CONFIRMATION',
  CONFIRMATION_EXPIRED: 'CONFIRMATION',
  CONFIRMATION_REVOKED: 'CONFIRMATION',
  CONFIRMATION_UNVERIFIABLE: 'CONFIRMATION',
  CREATE_INDETERMINATE: 'RESERVATION_EFFECT',
  CUTOVER_BLOCKER: 'CUTOVER',
  EXTERNAL_ITEM_CORRELATION_AMBIGUOUS: 'EXTERNAL_CORRELATION',
  EXTERNAL_ITEM_CORRELATION_UNRESOLVED: 'EXTERNAL_CORRELATION',
  EXTERNAL_LOCATION_CORRELATION_AMBIGUOUS: 'EXTERNAL_CORRELATION',
  EXTERNAL_LOCATION_CORRELATION_UNRESOLVED: 'EXTERNAL_CORRELATION',
  IMPORTED_COMMITTED_ORIGIN: 'IMPORTED_OBLIGATION',
  INCOMPATIBLE_UNIT: 'DEMAND_INPUT',
  INVALID_QUANTITY: 'DEMAND_INPUT',
  PARTIAL_CREATE_HOLD: 'RESERVATION_EFFECT',
  PHYSICAL_MUTATION_INDETERMINATE: 'PHYSICAL_EFFECT',
  POSSIBLE_PARTIAL_CREATE_HOLD: 'RESERVATION_EFFECT',
  POST_COMMIT_OBLIGATION_DEBT: 'COMMITTED_OBLIGATION',
  PRE_COMMIT_COMPENSATION_DEBT: 'RESERVATION_EFFECT',
  PROTECTION_AT_RISK: 'PROTECTION',
  PROTECTION_ESTABLISHMENT_INDETERMINATE: 'PROTECTION',
  PROTECTION_LATE_ESTABLISHMENT_PROVEN: 'PROTECTION',
  PROTECTION_PROTECTED: 'PROTECTION',
  RELEASE_INDETERMINATE: 'RESERVATION_EFFECT',
  SOURCE_COVERAGE_UNCERTAIN: 'SOURCE_ASSERTION',
  STOCK_CORRECTION_EVIDENCE_REQUIRED: 'STOCK_POSITION',
  STOCK_EVIDENCE_CONFLICTING: 'STOCK_POSITION',
  STOCK_EVIDENCE_INDETERMINATE: 'STOCK_POSITION',
  STOCK_EVIDENCE_MISSING: 'STOCK_POSITION',
  STOCK_EVIDENCE_STALE: 'STOCK_POSITION',
  UNRESOLVED_LEGACY_HOLD: 'LEGACY_HOLD',
} satisfies Record<InventoryOperationalProblemKind, InventoryOperationalSubjectTag>;

export const inventoryOperationalSubjectTagFor = (
  problem: InventoryOperationalProblemKind,
): InventoryOperationalSubjectTag => subjectTags[problem];

const ownerIdentityFor = (
  actualOwner: InventoryOperationalRecoveryPolicy['actualOwner'],
  authority: InventoryBackendConfiguration,
): InventoryOperationalOwnerIdentity => {
  const scope = { customerConfigurationId: authority.customerConfigurationId, tenantId: authority.tenantId };
  return Match.value(actualOwner).pipe(
    Match.when('CATALOG_TO_STOCK_BINDING_OWNER', () => ({
      _tag: 'CATALOG_TO_STOCK_BINDING_OWNER' as const,
      ...scope,
      ownerAuthority: 'INVENTORY_BINDING_OWNER' as const,
    })),
    Match.when('INVENTORY_CONFIGURATION_OWNER', () => ({
      _tag: 'INVENTORY_CONFIGURATION_OWNER' as const,
      ...scope,
      configurationId: authority.configurationId,
    })),
    Match.when('INVENTORY_INPUT_BOUNDARY', () => ({
      _tag: 'INVENTORY_INPUT_BOUNDARY' as const,
      ...scope,
      boundary: 'INVENTORY_PUBLIC_INPUT' as const,
    })),
    Match.when('INVENTORY_OBLIGATION_OWNER', () => ({
      _tag: 'INVENTORY_OBLIGATION_OWNER' as const,
      ...scope,
      ownerModuleId: 'commerce.inventory' as const,
    })),
    Match.when('ORIGINAL_RESERVATION_AUTHORITY', () => ({
      _tag: 'ORIGINAL_RESERVATION_AUTHORITY' as const,
      ...scope,
      backend: authority.selection.backend,
      backendId: authority.selection.backendId,
      configurationId: authority.configurationId,
    })),
    Match.when('SELECTED_INVENTORY_BACKEND', () => ({
      _tag: 'SELECTED_INVENTORY_BACKEND' as const,
      ...scope,
      backend: authority.selection.backend,
      backendId: authority.selection.backendId,
      configurationId: authority.configurationId,
    })),
    Match.exhaustive,
  );
};

const ownerIdentityKey = (identity: InventoryOperationalOwnerIdentity): string =>
  Match.value(identity).pipe(
    Match.tag('CATALOG_TO_STOCK_BINDING_OWNER', ({ customerConfigurationId, ownerAuthority, tenantId }) =>
      [customerConfigurationId, ownerAuthority, tenantId].join('|'),
    ),
    Match.tag('INVENTORY_CONFIGURATION_OWNER', ({ configurationId, customerConfigurationId, tenantId }) =>
      [configurationId, customerConfigurationId, tenantId].join('|'),
    ),
    Match.tag('INVENTORY_INPUT_BOUNDARY', ({ boundary, customerConfigurationId, tenantId }) =>
      [boundary, customerConfigurationId, tenantId].join('|'),
    ),
    Match.tag('INVENTORY_OBLIGATION_OWNER', ({ customerConfigurationId, ownerModuleId, tenantId }) =>
      [customerConfigurationId, ownerModuleId, tenantId].join('|'),
    ),
    Match.tag(
      'ORIGINAL_RESERVATION_AUTHORITY',
      ({ backend, backendId, configurationId, customerConfigurationId, tenantId }) =>
        [backend, backendId, configurationId, customerConfigurationId, tenantId].join('|'),
    ),
    Match.tag(
      'SELECTED_INVENTORY_BACKEND',
      ({ backend, backendId, configurationId, customerConfigurationId, tenantId }) =>
        [backend, backendId, configurationId, customerConfigurationId, tenantId].join('|'),
    ),
    Match.exhaustive,
  );
const ownerIdentityMatches = (
  left: InventoryOperationalOwnerIdentity,
  right: InventoryOperationalOwnerIdentity,
): boolean => ownerIdentityKey(left) === ownerIdentityKey(right);

const subjectRefTenantMatches = (subject: InventoryOperationalSubject): boolean =>
  Match.value(subject).pipe(
    Match.tag('BACKEND_CONFIGURATION', () => true),
    Match.tag('CATALOG_DEMAND', ({ demand, tenantId }) =>
      sameTenantId(demand.catalogSelection.productRef.tenantId, tenantId),
    ),
    Match.tag('COMMITTED_OBLIGATION', ({ obligationRef, tenantId }) => sameTenantId(obligationRef.tenantId, tenantId)),
    Match.tag('CONFIRMATION', ({ confirmationRef, tenantId }) => sameTenantId(confirmationRef.tenantId, tenantId)),
    Match.tag('CUTOVER', () => true),
    Match.tag('DEMAND_INPUT', ({ demand, tenantId }) =>
      sameTenantId(demand.catalogSelection.productRef.tenantId, tenantId),
    ),
    Match.tag(
      'EXTERNAL_CORRELATION',
      ({ customerConfigurationId, externalKey, tenantId }) =>
        sameTenantId(externalKey.tenantId, tenantId) && externalKey.customerConfigurationId === customerConfigurationId,
    ),
    Match.tag('IMPORTED_OBLIGATION', ({ obligationRef, tenantId }) => sameTenantId(obligationRef.tenantId, tenantId)),
    Match.tag('LEGACY_HOLD', () => true),
    Match.tag('PHYSICAL_EFFECT', ({ positionRef, tenantId }) => sameTenantId(positionRef.tenantId, tenantId)),
    Match.tag('PROTECTION', ({ protectionRef, tenantId }) => sameTenantId(protectionRef.tenantId, tenantId)),
    Match.tag('RESERVATION_EFFECT', ({ reservationRef, tenantId }) => sameTenantId(reservationRef.tenantId, tenantId)),
    Match.tag('SOURCE_ASSERTION', ({ positionRef, tenantId }) => sameTenantId(positionRef.tenantId, tenantId)),
    Match.tag('STOCK_POSITION', ({ positionRef, tenantId }) => sameTenantId(positionRef.tenantId, tenantId)),
    Match.exhaustive,
  );

const subjectTagOf = (subject: InventoryOperationalSubject): InventoryOperationalSubjectTag =>
  Match.value(subject).pipe(
    Match.tag('BACKEND_CONFIGURATION', () => 'BACKEND_CONFIGURATION' as const),
    Match.tag('CATALOG_DEMAND', () => 'CATALOG_DEMAND' as const),
    Match.tag('COMMITTED_OBLIGATION', () => 'COMMITTED_OBLIGATION' as const),
    Match.tag('CONFIRMATION', () => 'CONFIRMATION' as const),
    Match.tag('CUTOVER', () => 'CUTOVER' as const),
    Match.tag('DEMAND_INPUT', () => 'DEMAND_INPUT' as const),
    Match.tag('EXTERNAL_CORRELATION', () => 'EXTERNAL_CORRELATION' as const),
    Match.tag('IMPORTED_OBLIGATION', () => 'IMPORTED_OBLIGATION' as const),
    Match.tag('LEGACY_HOLD', () => 'LEGACY_HOLD' as const),
    Match.tag('PHYSICAL_EFFECT', () => 'PHYSICAL_EFFECT' as const),
    Match.tag('PROTECTION', () => 'PROTECTION' as const),
    Match.tag('RESERVATION_EFFECT', () => 'RESERVATION_EFFECT' as const),
    Match.tag('SOURCE_ASSERTION', () => 'SOURCE_ASSERTION' as const),
    Match.tag('STOCK_POSITION', () => 'STOCK_POSITION' as const),
    Match.exhaustive,
  );

const externalCorrelationMeaningMatches = (
  problem: InventoryOperationalProblemKind,
  subject: Extract<InventoryOperationalSubject, { readonly _tag: 'EXTERNAL_CORRELATION' }>,
): boolean =>
  Match.value(problem).pipe(
    Match.when(
      'EXTERNAL_ITEM_CORRELATION_AMBIGUOUS',
      () => subject.externalKey.identifierKind === 'ITEM' && subject.resolution === 'AMBIGUOUS',
    ),
    Match.when(
      'EXTERNAL_ITEM_CORRELATION_UNRESOLVED',
      () => subject.externalKey.identifierKind === 'ITEM' && subject.resolution === 'UNRESOLVED',
    ),
    Match.when(
      'EXTERNAL_LOCATION_CORRELATION_AMBIGUOUS',
      () => subject.externalKey.identifierKind === 'LOCATION' && subject.resolution === 'AMBIGUOUS',
    ),
    Match.when(
      'EXTERNAL_LOCATION_CORRELATION_UNRESOLVED',
      () => subject.externalKey.identifierKind === 'LOCATION' && subject.resolution === 'UNRESOLVED',
    ),
    Match.orElse(() => false),
  );

const protectionMeaningMatches = (
  problem: InventoryOperationalProblemKind,
  subject: Extract<InventoryOperationalSubject, { readonly _tag: 'PROTECTION' }>,
): boolean =>
  Match.value(problem).pipe(
    Match.when('PROTECTION_AT_RISK', () => subject.fence === 'AT_RISK'),
    Match.whenOr('PROTECTION_LATE_ESTABLISHMENT_PROVEN', 'PROTECTION_PROTECTED', () => subject.fence === 'ACTIVE'),
    Match.when('PROTECTION_ESTABLISHMENT_INDETERMINATE', () => subject.fence === 'PRESERVE_POSSIBLE_PROTECTION_FENCE'),
    Match.orElse(() => false),
  );

const subjectMeaningMatches = (problem: InventoryOperationalProblemKind, subject: InventoryOperationalSubject) =>
  Match.value(subject).pipe(
    Match.tag('EXTERNAL_CORRELATION', (correlation) => externalCorrelationMeaningMatches(problem, correlation)),
    Match.tag('PROTECTION', (protection) => protectionMeaningMatches(problem, protection)),
    Match.orElse(() => true),
  );

const subjectAuthorityMatches = (
  subject: InventoryOperationalSubject,
  selectedConfiguration: InventoryBackendConfiguration,
): boolean =>
  Match.value(subject).pipe(
    Match.tag(
      'BACKEND_CONFIGURATION',
      ({ configurationId }) => configurationId === selectedConfiguration.configurationId,
    ),
    Match.tag(
      'CUTOVER',
      ({ postCutoverConfigurationId }) => postCutoverConfigurationId === selectedConfiguration.configurationId,
    ),
    Match.tag(
      'EXTERNAL_CORRELATION',
      ({ externalKey }) =>
        externalKey.issuer.backendKind === selectedConfiguration.selection.backend &&
        externalKey.issuer.backendId === selectedConfiguration.selection.backendId,
    ),
    Match.orElse(() => true),
  );

export const InventoryCanonicalOperationalFindingSchema = Schema.TaggedStruct('OPERATIONAL_FINDING', {
  ownerIdentity: InventoryOperationalOwnerIdentitySchema,
  policy: InventoryOperationalRecoveryPolicySchema,
  problem: InventoryOperationalProblemKindSchema,
  reason: InventoryOperationalProblemKindSchema,
  scope: InventoryOperationalSubjectSchema,
  selectedConfiguration: InventoryBackendConfigurationSchema,
}).check(
  Schema.makeFilter(({ ownerIdentity, policy: actualPolicy, problem, reason, scope, selectedConfiguration }) => {
    const expectedPolicy = inventoryOperationalPolicyFor(problem);
    const expectedOwner = ownerIdentityFor(expectedPolicy.actualOwner, selectedConfiguration);
    return reason === problem &&
      subjectTagOf(scope) === inventoryOperationalSubjectTagFor(problem) &&
      sameTenantId(scope.tenantId, selectedConfiguration.tenantId) &&
      scope.customerConfigurationId === selectedConfiguration.customerConfigurationId &&
      subjectRefTenantMatches(scope) &&
      subjectMeaningMatches(problem, scope) &&
      subjectAuthorityMatches(scope, selectedConfiguration) &&
      ownerIdentityMatches(ownerIdentity, expectedOwner) &&
      samePolicy(actualPolicy, expectedPolicy)
      ? undefined
      : 'Operational finding must preserve its exact problem, owner identity, scope, reason, and safe policy';
  }),
);
export type InventoryCanonicalOperationalFinding = typeof InventoryCanonicalOperationalFindingSchema.Type;

export const makeInventoryOperationalFinding = (input: {
  readonly problem: InventoryOperationalProblemKind;
  readonly scope: InventoryOperationalSubject;
  readonly selectedConfiguration: InventoryBackendConfiguration;
}): InventoryCanonicalOperationalFinding => {
  const canonicalPolicy = inventoryOperationalPolicyFor(input.problem);
  return {
    _tag: 'OPERATIONAL_FINDING',
    ownerIdentity: ownerIdentityFor(canonicalPolicy.actualOwner, input.selectedConfiguration),
    policy: canonicalPolicy,
    problem: input.problem,
    reason: input.problem,
    scope: input.scope,
    selectedConfiguration: input.selectedConfiguration,
  };
};

export const InventoryBindingFailureFindingSchema = Schema.TaggedStruct('BINDING_FAILURE', {
  canonical: InventoryCanonicalOperationalFindingSchema,
  failure: CatalogToStockBindingResolutionFailure,
  inferredStockItemRef: Schema.Null,
  policy: InventoryOperationalRecoveryPolicySchema,
  problem: Schema.Literals(['BINDING_MISSING', 'BINDING_CONFLICTING', 'BINDING_INCOMPATIBLE']),
  scope: Schema.Struct({
    authority: InventoryBackendConfigurationSchema,
    demand: CatalogStockDemandSchema,
  }),
}).check(
  Schema.makeFilter(({ canonical, failure, problem, scope }) => {
    const expectedProblem = `BINDING_${failure.outcome}`;
    return sameTenantId(scope.authority.tenantId, scope.demand.catalogSelection.productRef.tenantId) &&
      canonical.problem === problem &&
      problem === expectedProblem
      ? undefined
      : 'Binding finding must preserve the exact demand Tenant and typed binding outcome';
  }),
);

export const InventorySourceCoverageUncertaintyFindingSchema = Schema.TaggedStruct('SOURCE_COVERAGE_UNCERTAINTY', {
  assertionId: InventorySourceAssertionSchema.fields.assertionId,
  authority: InventoryBackendConfigurationSchema,
  canonical: InventoryCanonicalOperationalFindingSchema,
  customerConfigurationId: InventorySourceAssertionSchema.fields.customerConfigurationId,
  evaluation: IndeterminateInventorySourceAssertionEvaluationSchema,
  issuer: InventorySourceAssertionSchema.fields.issuer,
  manualArithmeticAuthoritative: Schema.Literal(false),
  materialEffectIds: IndeterminateInventorySourceAssertionEvaluationSchema.fields.materialEffectIds,
  policy: InventoryOperationalRecoveryPolicySchema,
  positionRef: InventorySourceAssertionSchema.fields.positionRef,
  problem: Schema.Literal('SOURCE_COVERAGE_UNCERTAIN'),
  provenPostEffectOnHand: Schema.Null,
  quantity: StockQuantitySchema,
  reason: IndeterminateInventorySourceAssertionEvaluationSchema.fields.reason,
  reconciliationRequired: Schema.Literal(true),
  stockItemRef: InventorySourceAssertionSchema.fields.stockItemRef,
  stockLocationRef: InventorySourceAssertionSchema.fields.stockLocationRef,
}).check(
  Schema.makeFilter((finding) => {
    const { tenantId } = finding.authority;
    const { assertion } = finding.evaluation;
    const evaluationEffectIds = new Set(finding.evaluation.materialEffectIds);
    return finding.canonical.problem === finding.problem &&
      finding.assertionId === assertion.assertionId &&
      sameBackendConfiguration(finding.authority, assertion.authorityConfiguration) &&
      sameBackendConfiguration(finding.authority, finding.canonical.selectedConfiguration) &&
      finding.authority.customerConfigurationId === finding.customerConfigurationId &&
      finding.customerConfigurationId === assertion.customerConfigurationId &&
      finding.issuer.backendId === assertion.issuer.backendId &&
      finding.issuer.backendKind === assertion.issuer.backendKind &&
      finding.reason === finding.evaluation.reason &&
      finding.materialEffectIds.length === finding.evaluation.materialEffectIds.length &&
      finding.materialEffectIds.every((effectId) => evaluationEffectIds.has(effectId)) &&
      [
        finding.positionRef.tenantId,
        finding.quantity.unitRef.tenantId,
        finding.stockItemRef.tenantId,
        finding.stockLocationRef.tenantId,
      ].every((candidate) => sameTenantId(candidate, tenantId))
      ? undefined
      : 'Coverage uncertainty must preserve one exact authority, Position, Item, Location, and Unit scope';
  }),
);

export const InventoryPartialCreateDebtFindingSchema = Schema.TaggedStruct('PARTIAL_CREATE_DEBT', {
  attemptId: OrderCommitmentAttemptIdSchema,
  authority: InventoryBackendConfigurationSchema,
  canonical: InventoryCanonicalOperationalFindingSchema,
  effectId: ReservationAuthorityEffectIdSchema,
  evidenceState: Schema.Literals(['PROVEN_PARTIAL_HOLD', 'POSSIBLE_PARTIAL_HOLD']),
  heldAllocations: Schema.NonEmptyArray(ReservationCreateAllocationSchema),
  observedAt: Schema.toEncoded(Schema.DateTimeUtcFromString),
  ownerEvidenceRef: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300)),
  ),
  policy: InventoryOperationalRecoveryPolicySchema,
  problem: Schema.Literals(['PARTIAL_CREATE_HOLD', 'POSSIBLE_PARTIAL_CREATE_HOLD']),
  request: InventoryReservationCreateRequestSchema,
  requestedReservationRef: InventoryReservationRefSchema,
  safelyReusable: Schema.Literal(false),
  successfulReservationEstablished: Schema.Literal(false),
}).check(
  Schema.makeFilter(
    ({
      attemptId,
      authority,
      canonical,
      effectId,
      evidenceState,
      heldAllocations,
      ownerEvidenceRef,
      problem,
      request,
      requestedReservationRef,
    }) => {
      const { tenantId } = authority;
      const requestAllocations = request.reservation.requirements.flatMap(({ allocations }) => allocations);
      const heldAllocationIds = heldAllocations.map(({ allocationId }) => allocationId);
      const allocationsMatch = heldAllocations.every((held) =>
        requestAllocations.some(
          (planned) =>
            held.allocationId === planned.allocationId &&
            sameResourceRef(held.stockItemRef, planned.stockItemRef) &&
            sameResourceRef(held.stockPositionRef, planned.positionRef) &&
            sameResourceRef(held.quantity.unitRef, planned.quantity.unitRef) &&
            sameTenantId(held.stockItemRef.tenantId, authority.tenantId) &&
            sameTenantId(held.stockPositionRef.tenantId, authority.tenantId) &&
            sameTenantId(held.quantity.unitRef.tenantId, authority.tenantId) &&
            compareExactStockQuantityAmounts(held.quantity.amount, planned.quantity.amount) <= 0,
        ),
      );
      const authorityMatches = sameBackendConfiguration(authority, request.authority);
      const evidenceMatchesProblem =
        evidenceState === 'PROVEN_PARTIAL_HOLD'
          ? problem === 'PARTIAL_CREATE_HOLD' && ownerEvidenceRef !== undefined
          : problem === 'POSSIBLE_PARTIAL_CREATE_HOLD' && ownerEvidenceRef === undefined;
      return canonical.problem === problem &&
        sameTenantId(requestedReservationRef.tenantId, tenantId) &&
        sameResourceRef(request.reservation.ref, requestedReservationRef) &&
        request.reservation.origin.attemptId === attemptId &&
        request.effectId === effectId &&
        authorityMatches &&
        sameBackendConfiguration(authority, canonical.selectedConfiguration) &&
        evidenceMatchesProblem &&
        new Set(heldAllocationIds).size === heldAllocationIds.length &&
        allocationsMatch
        ? undefined
        : 'Partial create debt must preserve the original effect, Attempt, request requirements, allocations, and authority';
    },
  ),
);

export const InventoryOperationalFindingSchema = Schema.Union([
  InventoryCanonicalOperationalFindingSchema,
  InventoryBindingFailureFindingSchema,
  InventorySourceCoverageUncertaintyFindingSchema,
  InventoryPartialCreateDebtFindingSchema,
]).check(
  Schema.makeFilter(({ policy: actual, problem }) =>
    samePolicy(actual, inventoryOperationalPolicyFor(problem))
      ? undefined
      : 'Operational finding policy must match the canonical fail-closed recovery meaning',
  ),
);

const bindingProblemFor = (
  outcome: CatalogToStockBindingResolutionFailure['outcome'],
): 'BINDING_MISSING' | 'BINDING_CONFLICTING' | 'BINDING_INCOMPATIBLE' => `BINDING_${outcome}`;

export const investigateInventoryBindingFailure = (input: {
  readonly authority: InventoryBackendConfiguration;
  readonly demand: CatalogStockDemand;
  readonly failure: CatalogToStockBindingResolutionFailure;
}) => {
  const problem = bindingProblemFor(input.failure.outcome);
  const canonical = makeInventoryOperationalFinding({
    problem,
    scope: {
      _tag: 'CATALOG_DEMAND',
      customerConfigurationId: input.authority.customerConfigurationId,
      demand: input.demand,
      tenantId: input.authority.tenantId,
    },
    selectedConfiguration: input.authority,
  });
  return {
    _tag: 'BINDING_FAILURE' as const,
    canonical,
    failure: input.failure,
    inferredStockItemRef: null,
    policy: inventoryOperationalPolicyFor(problem),
    problem,
    scope: { authority: input.authority, demand: input.demand },
  };
};

export const InventorySourceCoverageUncertaintyInputSchema = IndeterminateInventorySourceAssertionEvaluationSchema;
export type InventorySourceCoverageUncertaintyInput = typeof InventorySourceCoverageUncertaintyInputSchema.Type;

export const investigateInventorySourceCoverageUncertainty = (input: InventorySourceCoverageUncertaintyInput) => {
  const canonical = makeInventoryOperationalFinding({
    problem: 'SOURCE_COVERAGE_UNCERTAIN',
    scope: {
      _tag: 'SOURCE_ASSERTION',
      assertionId: input.assertion.assertionId,
      customerConfigurationId: input.assertion.customerConfigurationId,
      materialEffectIds: input.materialEffectIds,
      positionRef: input.assertion.positionRef,
      tenantId: input.assertion.authorityConfiguration.tenantId,
    },
    selectedConfiguration: input.assertion.authorityConfiguration,
  });
  return {
    _tag: 'SOURCE_COVERAGE_UNCERTAINTY' as const,
    assertionId: input.assertion.assertionId,
    authority: input.assertion.authorityConfiguration,
    canonical,
    customerConfigurationId: input.assertion.customerConfigurationId,
    evaluation: input,
    issuer: input.assertion.issuer,
    manualArithmeticAuthoritative: false as const,
    materialEffectIds: input.materialEffectIds,
    policy: inventoryOperationalPolicyFor('SOURCE_COVERAGE_UNCERTAIN'),
    positionRef: input.assertion.positionRef,
    problem: 'SOURCE_COVERAGE_UNCERTAIN' as const,
    provenPostEffectOnHand: null,
    quantity: input.assertion.quantity,
    reason: input.reason,
    reconciliationRequired: true as const,
    stockItemRef: input.assertion.stockItemRef,
    stockLocationRef: input.assertion.stockLocationRef,
  };
};

export const InventoryPartialCreateDebtInputSchema = Schema.Union([
  ReconciliationRequiredReservationCreateEffectSchema,
  IndeterminateReservationCreateEffectSchema,
]);
export type InventoryPartialCreateDebtInput = typeof InventoryPartialCreateDebtInputSchema.Type;

const partialCreateDebtBase = (input: InventoryPartialCreateDebtInput) => ({
  _tag: 'PARTIAL_CREATE_DEBT' as const,
  attemptId: input.request.reservation.origin.attemptId,
  authority: input.request.authority,
  effectId: input.request.effectId,
  observedAt: input.observedAt,
  request: input.request,
  requestedReservationRef: input.request.reservation.ref,
  safelyReusable: false as const,
  successfulReservationEstablished: false as const,
});

export const investigateInventoryPartialCreateDebt = (input: InventoryPartialCreateDebtInput) =>
  Match.value(input).pipe(
    Match.tag('RECONCILIATION_REQUIRED', (effect) => ({
      ...partialCreateDebtBase(effect),
      canonical: makeInventoryOperationalFinding({
        problem: 'PARTIAL_CREATE_HOLD',
        scope: {
          _tag: 'RESERVATION_EFFECT',
          attemptId: effect.request.reservation.origin.attemptId,
          customerConfigurationId: effect.request.authority.customerConfigurationId,
          effectId: effect.request.effectId,
          reservationRef: effect.request.reservation.ref,
          tenantId: effect.request.authority.tenantId,
        },
        selectedConfiguration: effect.request.authority,
      }),
      evidenceState: 'PROVEN_PARTIAL_HOLD' as const,
      heldAllocations: effect.constrainedAllocations,
      ownerEvidenceRef: effect.ownerEvidenceRef,
      policy: inventoryOperationalPolicyFor('PARTIAL_CREATE_HOLD'),
      problem: 'PARTIAL_CREATE_HOLD' as const,
    })),
    Match.tag('INDETERMINATE', (effect) => ({
      ...partialCreateDebtBase(effect),
      canonical: makeInventoryOperationalFinding({
        problem: 'POSSIBLE_PARTIAL_CREATE_HOLD',
        scope: {
          _tag: 'RESERVATION_EFFECT',
          attemptId: effect.request.reservation.origin.attemptId,
          customerConfigurationId: effect.request.authority.customerConfigurationId,
          effectId: effect.request.effectId,
          reservationRef: effect.request.reservation.ref,
          tenantId: effect.request.authority.tenantId,
        },
        selectedConfiguration: effect.request.authority,
      }),
      evidenceState: 'POSSIBLE_PARTIAL_HOLD' as const,
      heldAllocations: effect.possibleConstrainedAllocations,
      policy: inventoryOperationalPolicyFor('POSSIBLE_PARTIAL_CREATE_HOLD'),
      problem: 'POSSIBLE_PARTIAL_CREATE_HOLD' as const,
    })),
    Match.exhaustive,
  );
