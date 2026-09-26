import { describe, expect, it } from 'effect-rstest';

import {
  inventoryGovernedReadContracts,
  inventoryPublicActionContracts,
  inventoryPublicOperationBoundaries,
  inventoryPublicOperations,
} from '../../shared/inventory-public-operations.ts';
// oxlint-disable-next-line import/no-namespace, sonarjs/no-wildcard-import -- The public-barrel contract test must enumerate runtime exports to reject extras; expires: 2027-03-31.
import * as inventoryPublicClient from '../../src/api/inventory-client.ts';

const expectedActionKeys = [
  'commerce.inventory.select-inventory-backend',
  'commerce.inventory.import-source-assertion',
  'commerce.inventory.resolve-inventory-source-conflict',
  'commerce.inventory.compensate-inventory-pre-commit',
  'commerce.inventory.create-inventory-reservation',
  'commerce.inventory.release-inventory-reservation',
  'commerce.inventory.establish-commitment-protection',
  'commerce.inventory.stock-receipt',
  'commerce.inventory.stock-issue',
  'commerce.inventory.correct-stock-position',
  'commerce.inventory.establish-catalog-to-stock-binding',
  'commerce.inventory.correct-catalog-to-stock-binding',
  'commerce.inventory.end-catalog-to-stock-binding',
  'commerce.inventory.establish-external-stock-correlation',
  'commerce.inventory.correct-external-stock-correlation',
  'commerce.inventory.end-external-stock-correlation',
  'commerce.inventory.establish-stock-sharing-eligibility',
  'commerce.inventory.change-stock-sharing-eligibility',
  'commerce.inventory.end-stock-sharing-eligibility',
  'commerce.inventory.recover-inventory-effect',
] as const;

const expectedReadSchemas = {
  'commerce.inventory.api.catalog-to-stock-binding-resolution': 'CatalogToStockBindingResolutionResponseSchema',
  'commerce.inventory.api.commitment-protection-verification': 'CommitmentProtectionVerificationResponseSchema',
  'commerce.inventory.api.current-stock-evidence-for-availability': 'CurrentStockEvidenceForAvailabilityResponseSchema',
  'commerce.inventory.api.inventory-backend-configuration-current':
    'InventoryBackendConfigurationCurrentResponseSchema',
  'commerce.inventory.api.inventory-effect-outcome': 'InventoryEffectOutcomeResponseSchema',
  'commerce.inventory.api.inventory-reconciliation-evidence': 'InventoryReconciliationEvidenceResponseSchema',
  'commerce.inventory.api.inventory-reservation-detail': 'InventoryReservationDetailResponseSchema',
  'commerce.inventory.api.inventory-source-conflict-detail': 'InventorySourceConflictDetailResponseSchema',
  'commerce.inventory.api.reservation-confirmation-verification': 'ReservationConfirmationVerificationResponseSchema',
  'commerce.inventory.api.stock-sharing-eligibility-resolution': 'StockSharingEligibilityResolutionResponseSchema',
} as const;

const operationClientStem = (key: string): string =>
  key
    .slice(key.lastIndexOf('.') + 1)
    .split('-')
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join('');

const expectedOperationClientExports = [...expectedActionKeys, ...Object.keys(expectedReadSchemas)].flatMap((key) => {
  const stem = operationClientStem(key);
  return [`execute${stem}`, `execute${stem}WithAuthorization`];
});

describe('Inventory public owner contracts', () => {
  it('enumerates every launch Action exactly once with immutable owner contract metadata', () => {
    expect(inventoryPublicActionContracts.map(({ key }) => key)).toEqual(expectedActionKeys);
    expect(new Set(inventoryPublicActionContracts.map(({ key }) => key)).size).toBe(expectedActionKeys.length);

    for (const operation of inventoryPublicActionContracts) {
      expect(operation).toMatchObject({ kind: 'ACTION', owner: 'commerce.inventory' });
      expect(operation.businessIntent.length).toBeGreaterThan(0);
      expect(operation.scopeSubject.length).toBeGreaterThan(0);
      expect(operation.authority.length).toBeGreaterThan(0);
      expect(operation.inputPrecision.length).toBeGreaterThan(0);
      expect(operation.idempotency.identity.length).toBeGreaterThan(0);
      expect(operation.idempotency.retry.length).toBeGreaterThan(0);
      expect(operation.idempotency.recovery.length).toBeGreaterThan(0);
      expect(operation.outcomes.sourceSchemaName.endsWith('ResultSchema')).toBe(true);
      expect(operation.outcomes.vocabulary.length).toBeGreaterThan(0);
      expect(operation.safeCallerNextSteps.length).toBeGreaterThan(0);
      expect(operation.boundaries.length).toBeGreaterThan(0);
    }
  });

  it('publishes the ten distinct governed reads with their exact stable key and response vocabulary', () => {
    expect(
      Object.fromEntries(inventoryGovernedReadContracts.map(({ key, outcomes }) => [key, outcomes.sourceSchemaName])),
    ).toEqual(expectedReadSchemas);
    expect(new Set(inventoryGovernedReadContracts.map(({ key }) => key)).size).toBe(10);

    for (const operation of inventoryGovernedReadContracts) {
      expect(operation).toMatchObject({ kind: 'GOVERNED_READ', owner: 'commerce.inventory' });
      expect(operation.idempotency.identity).toContain('read');
      expect(operation.outcomes.vocabulary.length).toBeGreaterThan(0);
      expect(operation.safeCallerNextSteps.length).toBeGreaterThan(0);
    }
  });

  it('makes every canonical boundary explicit and exposes no generic update or provider API', () => {
    expect(inventoryPublicOperationBoundaries.map(({ key }) => key)).toEqual([
      'ONE_CONFIGURATION_ONE_BACKEND',
      'OWNER_CONTRACT_ONLY',
      'EXACT_BINDING',
      'EXACT_QUANTITY_AND_UNIT',
      'ONE_RESERVATION_PER_ATTEMPT',
      'DISTINCT_MUTATION_IDENTITY',
      'RECOVER_ORIGINAL_IDENTITY',
      'CORRECTION_AUTHORITY_ONLY',
      'PROTECTION_IS_NOT_CONFIRMATION',
      'TYPED_SOURCE_COVERAGE',
      'NO_AUTOMATIC_BACKEND_FALLBACK',
      'POSITIVE_UNION_SHARING',
      'SHARING_CHANGES_NEW_RESERVATIONS_ONLY',
      'NO_AVAILABILITY_CONTRACT',
    ]);

    expect(inventoryPublicOperations).toHaveLength(30);
    expect(new Set(inventoryPublicOperations.map(({ key }) => key))).toHaveLength(30);
    const publicKeys = inventoryPublicOperations.map(({ key }) => key);
    expect(publicKeys.some((key) => key.includes('update-inventory'))).toBe(false);
    expect(publicKeys.some((key) => key.includes('provider'))).toBe(false);
    expect(
      inventoryPublicOperations.some(({ businessIntent }) => /availability computation/iu.test(businessIntent)),
    ).toBe(false);
  });

  it('exports exactly one direct and one authorized client helper for all 20 Actions and 10 governed reads', () => {
    const actualOperationClientExports = Object.keys(inventoryPublicClient).filter((key) => key.startsWith('execute'));

    expect(inventoryPublicActionContracts).toHaveLength(20);
    expect(inventoryGovernedReadContracts).toHaveLength(10);
    expect(new Set(actualOperationClientExports)).toEqual(new Set(expectedOperationClientExports));
    expect(actualOperationClientExports).toHaveLength(60);
  });

  it('maps exact relation lifecycles and recovery to their canonical boundaries', () => {
    const byKey = new Map(inventoryPublicOperations.map((operation) => [operation.key, operation]));

    for (const relation of ['catalog-to-stock-binding', 'external-stock-correlation'] as const) {
      for (const verb of ['establish', 'correct', 'end'] as const) {
        const operation = byKey.get(`commerce.inventory.${verb}-${relation}`);
        expect(operation?.scopeSubject).toContain(relation === 'catalog-to-stock-binding' ? 'Selection' : 'external');
      }
    }

    for (const verb of ['establish', 'change', 'end'] as const) {
      const operation = byKey.get(`commerce.inventory.${verb}-stock-sharing-eligibility`);
      expect(operation?.boundaries).toContain('POSITIVE_UNION_SHARING');
      expect(operation?.scopeSubject).toContain('Selling Legal Entity + Channel');
    }

    expect(byKey.get('commerce.inventory.recover-inventory-effect')?.boundaries).toContain('RECOVER_ORIGINAL_IDENTITY');
    expect(byKey.get('commerce.inventory.api.inventory-effect-outcome')?.safeCallerNextSteps).toContain(
      'Recover only the original effect identity when unresolved or indeterminate.',
    );
  });
});
