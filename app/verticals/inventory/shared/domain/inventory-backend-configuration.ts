import { Effect, Schema } from 'effect';

import { InventoryAuthorityAssignmentSchema, establishInventoryAuthority } from './inventory-authority.ts';
import { InventoryBackendConfigurationPersistenceUnavailable } from './inventory-backend-configuration-persistence-unavailable.ts';
import { InventoryBackendIdSchema } from './inventory-backend-identifiers.ts';
import { InventoryBackendSelectionRejected } from './inventory-backend-selection-rejected.ts';
import { InventoryReservationGuaranteeUnsupported } from './inventory-reservation-guarantee-unsupported.ts';
import { CustomerConfigurationIdSchema, InventoryBackendSchema } from '../inventory-launch-scope.ts';
import type { InventoryLaunchCutlineRejected } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { InventorySourceConflictRefSchema } from '../resources/inventory-source-conflict.ts';

const InventoryBackendConfigurationIdSchema = InventoryBackendConfigurationRefSchema.fields.resourceId;
const TenantIdSchema = InventoryBackendConfigurationRefSchema.fields.tenantId;
export const InventoryBackendConfigurationAuthorizationRefSchema = Schema.Struct({
  moduleId: InventoryBackendConfigurationRefSchema.fields.moduleId,
  resourceId: InventoryBackendConfigurationIdSchema.check(Schema.isUUID()),
  resourceType: InventoryBackendConfigurationRefSchema.fields.resourceType,
  tenantId: TenantIdSchema,
});
const InventoryInstantSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);
const InventoryCapabilitySupportSchema = Schema.Literals(['SUPPORTED', 'UNSUPPORTED']);

export const InventoryBackendSelectionSchema = Schema.Struct({
  backend: InventoryBackendSchema,
  backendId: InventoryBackendIdSchema,
  exactReservationCapability: InventoryCapabilitySupportSchema,
  stockCorrectionCapability: InventoryCapabilitySupportSchema,
}).check(
  Schema.makeFilter((selection) =>
    selection.backend === 'ontos_wms' &&
    (selection.exactReservationCapability !== 'SUPPORTED' || selection.stockCorrectionCapability !== 'SUPPORTED')
      ? 'OntOS WMS always exposes the required exact Reservation and Stock Correction capabilities'
      : undefined,
  ),
);
export type InventoryBackendSelection = typeof InventoryBackendSelectionSchema.Type;

export const SelectInventoryBackendPayloadSchema = Schema.Struct({
  authorizationTargetRef: InventoryBackendConfigurationAuthorizationRefSchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
  selection: InventoryBackendSelectionSchema,
});
export type SelectInventoryBackendPayload = typeof SelectInventoryBackendPayloadSchema.Type;

export const InventoryBackendConfigurationSchema = Schema.Struct({
  configurationId: InventoryBackendConfigurationIdSchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
  revision: Schema.Literal(1),
  selectedAt: InventoryInstantSchema,
  selection: InventoryBackendSelectionSchema,
  tenantId: TenantIdSchema,
});
export type InventoryBackendConfiguration = typeof InventoryBackendConfigurationSchema.Type;

export const SelectInventoryBackendResultSchema = Schema.Union([
  Schema.Struct({
    configuration: InventoryBackendConfigurationSchema,
    outcome: Schema.Literals(['SELECTED', 'EXACT_REPLAY']),
  }),
  Schema.Struct({
    configuration: InventoryBackendConfigurationSchema,
    conflictRef: InventorySourceConflictRefSchema,
    fallbackApplied: Schema.Literal(false),
    outcome: Schema.Literal('BACKEND_CONFIGURATION_CONFLICT'),
  }),
]);
export type SelectInventoryBackendResult = typeof SelectInventoryBackendResultSchema.Type;

export const SelectInventoryBackendErrorSchema = Schema.Union([
  InventoryBackendSelectionRejected,
  InventoryBackendConfigurationPersistenceUnavailable,
]);
export type SelectInventoryBackendError = typeof SelectInventoryBackendErrorSchema.Type;

export const InventoryReservationAuthorityDispatchSchema = Schema.Struct({
  authority: InventoryAuthorityAssignmentSchema,
  backendId: InventoryBackendIdSchema,
});
export type InventoryReservationAuthorityDispatch = typeof InventoryReservationAuthorityDispatchSchema.Type;

export const sameInventoryBackendSelection = (
  left: InventoryBackendSelection,
  right: InventoryBackendSelection,
): boolean =>
  left.backendId === right.backendId &&
  left.backend === right.backend &&
  left.exactReservationCapability === right.exactReservationCapability &&
  left.stockCorrectionCapability === right.stockCorrectionCapability;

export const dispatchReservationAuthority = (
  configuration: InventoryBackendConfiguration,
): Effect.Effect<
  InventoryReservationAuthorityDispatch,
  InventoryLaunchCutlineRejected | InventoryReservationGuaranteeUnsupported
> => {
  const { selection } = configuration;
  if (selection.exactReservationCapability === 'UNSUPPORTED') {
    return Effect.fail(
      new InventoryReservationGuaranteeUnsupported({
        code: 'inventory_reservation_guarantee_unsupported',
        fallbackApplied: false,
        proofIssued: false,
        reason: 'selected_backend_does_not_support_required_guarantee',
        selectedBackendId: selection.backendId,
      }),
    );
  }
  return establishInventoryAuthority({
    customerConfigurationId: configuration.customerConfigurationId,
    selectedBackends: [selection.backend],
  }).pipe(Effect.map((authority) => ({ authority, backendId: selection.backendId })));
};
