import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  establishCommitmentProtection,
  markCommitmentProtectionAtRisk,
} from '../../shared/domain/commitment-protection.ts';
import type { CommitmentProtection } from '../../shared/domain/commitment-protection.ts';
import {
  EstablishInventoryReservationInputSchema,
  establishInventoryReservation,
} from '../../shared/domain/inventory-obligation.ts';
import { establishReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { CommitmentProtectionRefSchema } from '../../shared/resources/commitment-protection.ts';
import { ReservationConfirmationRefSchema } from '../../shared/resources/reservation-confirmation.ts';
import { StockItemRefSchema } from '../../shared/resources/stock-item.ts';
import {
  commitmentProtectionPersistenceForScope,
  decodeCommitmentProtectionHistoryRows,
} from '../../src/persistence/commitment-protection-repository.ts';
import { inventoryCatalogToStockBindings } from '../../src/persistence/catalog-to-stock-binding-table.ts';
import {
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
} from '../../src/persistence/commitment-protection-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const reservationId = '22222222-2222-4222-8222-222222222222';
const confirmationId = '33333333-3333-4333-8333-333333333333';
const protectionId = '44444444-4444-4444-8444-444444444444';
const itemId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const positionId = '77777777-7777-4777-8777-777777777777';
const configurationId = '88888888-8888-4888-8888-888888888888';
const bindingId = '99999999-9999-4999-8999-999999999999';
const issuedAt = '2026-09-24T10:00:00.000Z';
const expiresAt = '2026-09-24T10:15:00.000Z';
const establishedAt = '2026-09-24T10:05:00.000Z';
const attemptId = 'attempt-checkout-1';
const protectionEffectId = Schema.decodeSync(ReservationAuthorityEffectIdSchema)('effect:protection:attempt-1');

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const itemRef = Schema.decodeUnknownSync(StockItemRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
});
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: issuedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});
const reservationInput = Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema)({
  authority: {
    configurationId,
    customerConfigurationId: 'customer-configuration-primary',
    revision: 1,
    selectedAt: '2026-09-24T09:00:00.000Z',
    selection: {
      backend: 'external_business_system',
      backendId: 'erp-primary',
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: 'UNSUPPORTED',
    },
    tenantId,
  },
  establishedAt: issuedAt,
  origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: reservationId,
    resourceType: 'commerce.inventory.inventory-reservation',
    tenantId,
  },
  requirements: [
    {
      allocations: [
        {
          allocationId: 'allocation-1',
          positionRef: {
            moduleId: 'commerce.inventory',
            resourceId: positionId,
            resourceType: 'commerce.inventory.stock-position',
            tenantId,
          },
          quantity: { amount: '10', unitRef },
          stockItemRef: itemRef,
        },
      ],
      bindingRef: {
        moduleId: 'commerce.inventory',
        resourceId: bindingId,
        resourceType: 'commerce.inventory.catalog-to-stock-binding',
        tenantId,
      },
      catalogSelection: selection,
      exactSelectionMeaning,
      purchaseDemandOccurrenceId: 'demand-occurrence-1',
      quantity: '10',
      stockItem,
      unitRef,
    },
  ],
});

const confirmationRef = Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: confirmationId,
  resourceType: 'commerce.inventory.reservation-confirmation',
  tenantId,
});
const protectionRef = Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: protectionId,
  resourceType: 'commerce.inventory.commitment-protection',
  tenantId,
});

const makeProtection = Effect.gen(function* makeProtectionEffect() {
  const reservation = yield* establishInventoryReservation(reservationInput);
  const allocations = reservation.requirements.flatMap(({ allocations: requirementAllocations }) =>
    requirementAllocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
      allocationId,
      quantity,
      stockItemRef,
      stockPositionRef: positionRef,
    })),
  );
  const confirmationEvidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
    effectId: 'effect:confirmation:attempt-1',
    evidence: {
      allocations,
      attemptId,
      customerConfigurationId: 'customer-configuration-primary',
      ownerEvidenceRef: 'owner-proof:confirmation:1',
      reservationId,
      tenantId,
      validFrom: issuedAt,
      validUntil: expiresAt,
    },
    issuer: { backend: 'external_business_system', backendId: 'erp-primary', origin: 'EXTERNAL_BUSINESS_SYSTEM' },
    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
    operation: 'RESERVATION_CONFIRMATION',
  });
  const confirmation = yield* establishReservationConfirmation({
    authorityEvidence: confirmationEvidence,
    confirmationRef,
    reservation,
  });
  const protectionEvidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
    effectId: protectionEffectId,
    evidence: {
      allocations,
      attemptId,
      customerConfigurationId: 'customer-configuration-primary',
      ownerEvidenceRef: 'owner-proof:protection:1',
      reservationId,
      tenantId,
      validFrom: establishedAt,
      validUntil: '2026-09-25T10:00:00.000Z',
    },
    issuer: { backend: 'external_business_system', backendId: 'erp-primary', origin: 'EXTERNAL_BUSINESS_SYSTEM' },
    kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
    operation: 'COMMITMENT_PROTECTION',
  });
  return yield* establishCommitmentProtection({
    authorityEvidence: protectionEvidence,
    confirmation,
    protectionRef,
  });
});

const scope = { tenantId } as const;

const currentBindingRows = [{ bindingId, stockItemId: itemId }];
const lockingRows = () => {
  const result = Effect.succeed(currentBindingRows);
  return Object.assign(result, { limit: () => result });
};
type ProtectionSelectTable =
  | typeof inventoryCatalogToStockBindings
  | typeof inventoryCommitmentProtectionHistory
  | typeof inventoryCommitmentProtections;

const selectRows = (rows: readonly unknown[]) => ({
  from: (table: ProtectionSelectTable) => ({
    where: () => {
      const result = Effect.succeed(table === inventoryCatalogToStockBindings ? currentBindingRows : rows);
      return Object.assign(result, { for: lockingRows, limit: () => result, orderBy: () => result });
    },
  }),
});

type ProtectionTable = typeof inventoryCommitmentProtections | typeof inventoryCommitmentProtectionHistory;

/* oxlint-disable sonarjs/no-nested-functions -- Typed transaction mocks mirror the Drizzle fluent chains; expires: 2027-03-31. */
const insertProtectionTransaction = (protection: CommitmentProtection, insertedTables: ProtectionTable[]) => ({
  insert: (table: ProtectionTable) => {
    insertedTables.push(table);
    return {
      values: () =>
        table === inventoryCommitmentProtections
          ? {
              onConflictDoNothing: () => ({
                returning: () =>
                  Effect.succeed([{ authorityEffectId: protection.authorityEvidence.effectId, snapshot: protection }]),
              }),
            }
          : Effect.succeed([]),
    };
  },
  select: () => selectRows([]),
});

const replayProtectionTransaction = (protection: CommitmentProtection) => ({
  insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => Effect.succeed([]) }) }) }),
  select: () =>
    selectRows([
      {
        attemptId,
        authorityEffectId: protection.authorityEvidence.effectId,
        confirmationId,
        protectionId: protection.ref.resourceId,
        reservationId,
        snapshot: protection,
      },
    ]),
});

const siblingProtectionTransaction = (protection: CommitmentProtection) => ({
  insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => Effect.succeed([]) }) }) }),
  select: () =>
    selectRows([
      {
        attemptId,
        authorityEffectId: protection.authorityEvidence.effectId,
        confirmationId,
        protectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        reservationId,
        snapshot: protection,
      },
    ]),
});

const updateProtectionTransaction = (protection: CommitmentProtection, insertedTables: ProtectionTable[]) => ({
  insert: (table: ProtectionTable) => {
    insertedTables.push(table);
    return { values: () => Effect.succeed([]) };
  },
  update: () => ({
    set: () => ({
      where: () => ({
        returning: () =>
          Effect.succeed([{ authorityEffectId: protection.authorityEvidence.effectId, snapshot: protection }]),
      }),
    }),
  }),
});
/* oxlint-enable sonarjs/no-nested-functions */

describe('Commitment Protection persistence', () => {
  it.effect('atomically stores the first Protection and its immutable first history revision', () =>
    Effect.gen(function* storeProtection() {
      const protection = yield* makeProtection;
      const insertedTables: ProtectionTable[] = [];
      const transaction = insertProtectionTransaction(protection, insertedTables);
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = commitmentProtectionPersistenceForScope(transaction, scope);

      const stored = yield* persistence.createOrRead(protection);

      expect(stored).toEqual({ outcome: 'INSERTED', protection });
      expect(insertedTables).toEqual([inventoryCommitmentProtections, inventoryCommitmentProtectionHistory]);
    }),
  );

  it.effect('reads the durable winner after an exact uniqueness race instead of issuing another Protection', () =>
    Effect.gen(function* replayProtection() {
      const protection = yield* makeProtection;
      const transaction = replayProtectionTransaction(protection);
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = commitmentProtectionPersistenceForScope(transaction, scope);

      const replay = yield* persistence.createOrRead(protection);

      expect(replay).toEqual({ outcome: 'EXISTING', protection });
    }),
  );

  it.effect('rejects a sibling Protection for the same Reservation and Attempt', () =>
    Effect.gen(function* rejectSiblingProtection() {
      const protection = yield* makeProtection;
      const transaction = siblingProtectionTransaction(protection);
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = commitmentProtectionPersistenceForScope(transaction, scope);

      const failure = yield* persistence.createOrRead(protection).pipe(Effect.flip);

      expect(failure).toMatchObject({ effectId: protectionEffectId, reason: 'SIBLING_PROTECTION_FORBIDDEN' });
    }),
  );

  it.effect('persists only a monotonic AT_RISK revision and appends immutable history', () =>
    Effect.gen(function* saveAtRiskRevision() {
      const protection = yield* makeProtection;
      const atRisk = yield* markCommitmentProtectionAtRisk(protection, {
        _tag: 'MATERIAL_IMPAIRMENT',
        effectiveAt: '2026-09-24T10:10:00.000Z',
        ownerEvidenceRef: 'owner-proof:impairment:1',
      });
      const insertedTables: ProtectionTable[] = [];
      const transaction = updateProtectionTransaction(atRisk, insertedTables);
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = commitmentProtectionPersistenceForScope(transaction, scope);

      const stored = yield* persistence.saveRevision({ current: protection, next: atRisk });

      expect(stored).toEqual(atRisk);
      expect(stored).toMatchObject({ health: { reconciliationRequired: true, state: 'AT_RISK' }, revision: 2 });
      expect(insertedTables).toEqual([inventoryCommitmentProtectionHistory]);
    }),
  );

  it.effect('rejects a cross-tenant write before touching the scoped transaction', () =>
    Effect.gen(function* rejectCrossTenant() {
      const protection = yield* makeProtection;
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('must not touch transaction');
          },
        },
      );
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = commitmentProtectionPersistenceForScope(transaction, {
        tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });

      const failure = yield* persistence.createOrRead(protection).pipe(Effect.flip);

      expect(failure).toMatchObject({ effectId: protectionEffectId, reason: 'TENANT_SCOPE_MISMATCH' });
    }),
  );

  it.effect('decodes append-only history without dropping the original protected revision', () =>
    Effect.gen(function* readHistory() {
      const protection = yield* makeProtection;
      const atRisk = yield* markCommitmentProtectionAtRisk(protection, {
        _tag: 'BINDING_CORRECTION',
        correctionEvidenceRef: 'catalog-binding-correction:1',
        effectiveAt: '2026-09-24T10:10:00.000Z',
      });

      const history = yield* decodeCommitmentProtectionHistoryRows(protectionEffectId, [
        { snapshot: protection },
        { snapshot: atRisk },
      ]);

      expect(history).toEqual([protection, atRisk]);
      expect(history[0]).toMatchObject({ health: { state: 'PROTECTED' }, revision: 1 });
      expect(history[1]).toMatchObject({ health: { state: 'AT_RISK' }, revision: 2 });
    }),
  );
});
