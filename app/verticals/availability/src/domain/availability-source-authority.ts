import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';
import type { InventoryBackendConfiguration } from '@app/inventory/backend-configuration';
import { Effect, Match, Schema } from 'effect';

import {
  AvailabilityInventoryPositionEvidenceSchema,
  AvailabilitySourceAuthorityRejected,
  AvailabilityStockInputSchema,
} from '../../shared/domain/availability-source-authority.ts';
import type {
  AvailabilityInventoryPositionEvidence,
  AvailabilityStockInput,
} from '../../shared/domain/availability-source-authority.ts';
import type { AvailabilitySubject } from '../../shared/domain/availability-subject.ts';

const sameConfiguration = Schema.toEquivalence(InventoryBackendConfigurationSchema);
const sameOnHand = Schema.toEquivalence(AvailabilityInventoryPositionEvidenceSchema.fields.position.fields.onHand);
const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);

const sameResource = (
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
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const positionScopeMatches = (
  evidence: AvailabilityInventoryPositionEvidence,
  subject: AvailabilitySubject,
  configuration: InventoryBackendConfiguration,
): boolean => {
  const { binding, position, provisionalReserved, stockItem, stockLocation } = evidence;
  const ownerRef = position.onHand.ownerConfigurationRef;
  return (
    position.ref.tenantId === configuration.tenantId &&
    position.scope.customerConfigurationId === configuration.customerConfigurationId &&
    ownerRef.resourceId === configuration.configurationId &&
    ownerRef.tenantId === configuration.tenantId &&
    sameOnHand(evidence.sourceEvidence.onHand, position.onHand) &&
    sameSelection(binding.catalogSelection, subject.selection) &&
    sameResource(binding.stockItemRef, stockItem.stockItemRef) &&
    sameResource(position.scope.stockItemRef, stockItem.stockItemRef) &&
    sameResource(position.scope.stockLocationRef, stockLocation.ref) &&
    sameResource(binding.unitRef, subject.quantity.unitRef) &&
    sameResource(stockItem.unitRef, subject.quantity.unitRef) &&
    sameResource(position.scope.unitRef, subject.quantity.unitRef) &&
    binding.exactSelectionMeaning.id === stockItem.exactSelectionMeaning.id &&
    binding.exactSelectionMeaning.kind === stockItem.exactSelectionMeaning.kind &&
    (provisionalReserved.currentness !== 'CURRENT' ||
      sameResource(provisionalReserved.quantity.unitRef, subject.quantity.unitRef))
  );
};

const sourceAuthorityMatches = (
  evidence: AvailabilityInventoryPositionEvidence,
  configuration: InventoryBackendConfiguration,
): boolean => {
  const source = evidence.sourceEvidence;
  if (!sameConfiguration(source.ownerConfiguration, configuration)) {
    return false;
  }
  return Match.value(source).pipe(
    Match.tag('OWNER_MANAGED', () => configuration.selection.backend === 'ontos_wms'),
    Match.tag('MISSING', () => configuration.selection.backend === 'external_business_system'),
    Match.tag('EXTERNAL_SOURCE_ASSERTION', ({ evaluation }) => {
      const { assertion } = evaluation;
      return (
        configuration.selection.backend === 'external_business_system' &&
        sameConfiguration(assertion.authorityConfiguration, configuration) &&
        assertion.issuerAuthority === 'SELECTED_BACKEND' &&
        assertion.issuer.backendId === configuration.selection.backendId &&
        assertion.issuer.backendKind === configuration.selection.backend &&
        assertion.customerConfigurationId === configuration.customerConfigurationId &&
        sameResource(assertion.positionRef, evidence.position.ref) &&
        sameResource(assertion.stockItemRef, evidence.stockItem.stockItemRef) &&
        sameResource(assertion.stockLocationRef, evidence.stockLocation.ref) &&
        sameResource(assertion.quantity.unitRef, evidence.position.scope.unitRef)
      );
    }),
    Match.exhaustive,
  );
};

/**
 * Trusted composition supplies the selected configuration and exact subject independently of input.
 * This validates provenance, not Currentness or promise quantity: uncertain stock stays uncertain,
 * a transport outage supplies no stock fact, and retained evidence needs owner validation for use.
 */
export const validateAvailabilitySourceAuthority = Effect.fn('validateAvailabilitySourceAuthority')(
  function* validateAvailabilitySourceAuthority(
    input: AvailabilityStockInput,
    expected: { readonly configuration: InventoryBackendConfiguration; readonly subject: AvailabilitySubject },
  ) {
    const evidence = yield* Schema.decodeEffect(AvailabilityStockInputSchema, { onExcessProperty: 'error' })(
      input,
    ).pipe(
      Effect.mapError((cause) => new AvailabilitySourceAuthorityRejected({ cause, reason: 'INVALID_OWNER_EVIDENCE' })),
    );
    const { configuration, subject } = expected;
    if (
      !sameConfiguration(evidence.selectedBackendConfiguration, configuration) ||
      configuration.tenantId !== subject.selection.productRef.tenantId
    ) {
      return yield* new AvailabilitySourceAuthorityRejected({ reason: 'SELECTED_AUTHORITY_MISMATCH' });
    }
    for (const position of evidence.positions) {
      if (!positionScopeMatches(position, subject, configuration)) {
        return yield* new AvailabilitySourceAuthorityRejected({ reason: 'EVIDENCE_SCOPE_MISMATCH' });
      }
      if (!sourceAuthorityMatches(position, configuration)) {
        return yield* new AvailabilitySourceAuthorityRejected({ reason: 'SELECTED_AUTHORITY_MISMATCH' });
      }
    }
    return evidence;
  },
);
