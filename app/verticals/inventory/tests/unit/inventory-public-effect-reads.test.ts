import { ReadHandlerNotFound } from '@app/core-runtime';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { mapCommitmentProtectionVerificationDomainError } from '../../api/commitment-protection-verification-read-server.ts';
import { mapInventoryEffectOutcomeDomainError } from '../../api/inventory-effect-outcome-read-server.ts';
import { CommitmentProtectionVerificationRequestSchema } from '../../shared/apis/commitment-protection-verification.ts';
import { CommitmentProtectionVerificationDomainConflictProblemSchema } from '../../shared/apis/commitment-protection-verification-domain-conflict-problem.ts';
import {
  InventoryEffectOutcomeRequestSchema,
  InventoryEffectOutcomeResponseSchema,
} from '../../shared/apis/inventory-effect-outcome.ts';
import { InventoryEffectOutcomeDomainConflictProblemSchema } from '../../shared/apis/inventory-effect-outcome-domain-conflict-problem.ts';
import { InventoryEffectOutcomeDomainUnavailableProblemSchema } from '../../shared/apis/inventory-effect-outcome-domain-unavailable-problem.ts';
import type { CommitmentProtectionPersistence } from '../../shared/domain/commitment-protection.ts';
import { CommitmentProtectionRejected } from '../../shared/domain/commitment-protection.ts';
import {
  InventoryEffectLedgerConflict,
  InventoryEffectLedgerEffectIdSchema,
  InventoryEffectLedgerRecordSchema,
  InventoryEffectLedgerUnavailable,
} from '../../shared/domain/inventory-effect-ledger.ts';
import { PhysicalStockEffectRequestSchema } from '../../shared/domain/physical-stock-effect.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import {
  commitmentProtectionVerificationPermissionTarget,
  commitmentProtectionVerificationRead,
} from '../../src/api/commitment-protection-verification.read.ts';
import {
  inventoryEffectOutcomePermissionTarget,
  inventoryEffectOutcomeRead,
} from '../../src/api/inventory-effect-outcome.read.ts';
import type {
  InventoryEffectLedgerPersistence,
  InventoryEffectLedgerService,
} from '../../src/services/inventory-effect-ledger.service.ts';
import { physicalStockLedgerIntent } from '../../src/services/inventory-effect-ledger.service.ts';
import {
  getReadHandler,
  getReadPermissionTargetResolver,
} from '../../../../packages/core-runtime/src/reads/definition.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const effectId = InventoryEffectLedgerEffectIdSchema.make('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
const scope = {
  authBindingId: '33333333-3333-4333-8333-333333333333',
  authContextRef: 'better-auth-session:inventory-effect-read-test',
  authMethod: 'session' as const,
  correlationId: 'inventory-effect-read-test',
  legalEntityId,
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
};

const physicalRequest = Schema.decodeUnknownSync(PhysicalStockEffectRequestSchema)({
  actionInvocationId: '55555555-5555-4555-8555-555555555555',
  backend: 'external_business_system',
  backendConfigurationRef: {
    moduleId: 'commerce.inventory',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.inventory.inventory-backend-configuration',
    tenantId,
  },
  backendId: 'erp-primary',
  customerConfigurationId: 'customer-configuration-primary',
  effectId,
  kind: 'ISSUE',
  legalEntityId,
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  quantity: {
    amount: '2',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '88888888-8888-4888-8888-888888888888',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42' },
  requestedAt: '2026-09-25T10:00:00.000Z',
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: '99999999-9999-4999-8999-999999999999',
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  stockLocationRef: {
    moduleId: 'commerce.inventory',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  },
});
const intent = physicalStockLedgerIntent({ _tag: 'REQUESTED', request: physicalRequest });
const effectRequest = Schema.decodeUnknownSync(InventoryEffectOutcomeRequestSchema)({ effectId, intent });

const unusedLedgerOperation = () => Effect.die('unused test operation');
const ledgerFor = (record?: typeof InventoryEffectLedgerRecordSchema.Type): InventoryEffectLedgerService => ({
  claim: unusedLedgerOperation,
  recover: () =>
    record === undefined
      ? Effect.die('unexpected recovery without a record')
      : Effect.succeed({ outcome: 'EXACT_REPLAY', record }),
  transition: unusedLedgerOperation,
});
const persistenceFor = (record?: typeof InventoryEffectLedgerRecordSchema.Type): InventoryEffectLedgerPersistence => ({
  createOrRead: unusedLedgerOperation,
  read: () => Effect.succeed(record === undefined ? Option.none() : Option.some(record)),
  save: unusedLedgerOperation,
});

it('binds both reads to the exact requested Inventory Resource', () => {
  expect(commitmentProtectionVerificationRead.descriptor.permissionTarget).toBe('business_permission');
  expect(inventoryEffectOutcomeRead.descriptor.permissionTarget).toBe('business_permission');
  expect(Predicate.isFunction(getReadPermissionTargetResolver(commitmentProtectionVerificationRead))).toBe(true);
  expect(Predicate.isFunction(getReadPermissionTargetResolver(inventoryEffectOutcomeRead))).toBe(true);

  const protectionRequest = Schema.decodeUnknownSync(CommitmentProtectionVerificationRequestSchema)({
    attemptId: 'attempt-42',
    protectionRef: {
      moduleId: 'commerce.inventory',
      resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      resourceType: 'commerce.inventory.commitment-protection',
      tenantId,
    },
    reservationRef: {
      moduleId: 'commerce.inventory',
      resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
  });

  expect(commitmentProtectionVerificationPermissionTarget(protectionRequest, scope)).toMatchObject({
    businessPermission: { target: { resource: protectionRequest.protectionRef, tenantId } },
  });
  expect(inventoryEffectOutcomePermissionTarget(effectRequest, scope)).toMatchObject({
    businessPermission: { target: { resource: physicalRequest.positionRef, tenantId } },
  });
});

it.effect('returns typed unresolved and indeterminate outcomes only under the original full intent', () =>
  Effect.gen(function* resolveEffectOutcome() {
    const handler = getReadHandler(inventoryEffectOutcomeRead);
    const unresolved = yield* handler(effectRequest, {
      readKey: inventoryEffectOutcomeRead.descriptor.readKey,
      scope,
      services: { ledger: ledgerFor(), persistence: persistenceFor() },
    });
    expect(
      Match.value(unresolved.result).pipe(
        Match.tag('UNRESOLVED', ({ effectId: actualEffectId, nextStep }) => ({ actualEffectId, nextStep })),
        Match.orElse(() => null),
      ),
    ).toEqual({ actualEffectId: effectId, nextStep: 'RECOVER_ORIGINAL_EFFECT' });
    expect(Schema.is(InventoryEffectOutcomeResponseSchema)(unresolved.result)).toBe(true);

    const record = Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
      currentState: 'INDETERMINATE',
      effectId,
      intent,
      requestedAt: '2026-09-25T10:00:00.000Z',
      resolution: null,
      revision: 2,
      tenantId,
      updatedAt: '2026-09-25T10:01:00.000Z',
    });
    const indeterminate = yield* handler(effectRequest, {
      readKey: inventoryEffectOutcomeRead.descriptor.readKey,
      scope,
      services: { ledger: ledgerFor(record), persistence: persistenceFor(record) },
    });
    expect(
      Match.value(indeterminate.result).pipe(
        Match.tag('INDETERMINATE', ({ effectId: actualEffectId, nextStep, resolution }) => ({
          actualEffectId,
          nextStep,
          resolution,
        })),
        Match.orElse(() => null),
      ),
    ).toEqual({ actualEffectId: effectId, nextStep: 'RECOVER_ORIGINAL_EFFECT', resolution: null });
    expect(Schema.is(InventoryEffectOutcomeResponseSchema)(indeterminate.result)).toBe(true);
  }),
);

it.effect('does not reveal a Protection outside the exact Tenant scope', () =>
  Effect.gen(function* hideCrossTenantProtection() {
    let reads = 0;
    const protections: CommitmentProtectionPersistence = {
      createOrRead: unusedLedgerOperation,
      findByRef: () => {
        reads += 1;
        return Effect.succeedNone;
      },
      findByReservationAttempt: unusedLedgerOperation,
      readHistory: unusedLedgerOperation,
      saveRevision: unusedLedgerOperation,
    };
    const request = Schema.decodeUnknownSync(CommitmentProtectionVerificationRequestSchema)({
      attemptId: 'attempt-42',
      protectionRef: {
        moduleId: 'commerce.inventory',
        resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        resourceType: 'commerce.inventory.commitment-protection',
        tenantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
      reservationRef: {
        moduleId: 'commerce.inventory',
        resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        resourceType: 'commerce.inventory.inventory-reservation',
        tenantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    });
    const failure = yield* getReadHandler(commitmentProtectionVerificationRead)(request, {
      readKey: commitmentProtectionVerificationRead.descriptor.readKey,
      scope,
      services: protections,
    }).pipe(Effect.flip);

    expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
    expect(reads).toBe(0);
  }),
);

it('rejects changed effect identity and maps conflict/unavailable without private details', () => {
  expect(Schema.is(InventoryEffectOutcomeRequestSchema)({ ...effectRequest, effectId: 'different-effect-id' })).toBe(
    false,
  );

  const conflictProblem = mapInventoryEffectOutcomeDomainError(
    new InventoryEffectLedgerConflict({
      attemptedKind: 'PHYSICAL_ISSUE',
      code: 'inventory_effect_ledger_conflict',
      effectId,
      existingKind: 'PHYSICAL_RECEIPT',
      reason: 'MATERIAL_INTENT_CONFLICT',
    }),
  );
  const unavailableProblem = mapInventoryEffectOutcomeDomainError(
    new InventoryEffectLedgerUnavailable({
      code: 'inventory_effect_ledger_unavailable',
      effectId,
      reason: 'private database detail',
      retryable: true,
    }),
  );
  const protectionConflict = mapCommitmentProtectionVerificationDomainError(
    new CommitmentProtectionRejected({
      code: 'commitment_protection_rejected',
      effectId: Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)(effectId),
      reason: 'CONFIRMATION_SCOPE_MISMATCH',
    }),
  );

  expect(Schema.is(InventoryEffectOutcomeDomainConflictProblemSchema)(conflictProblem)).toBe(true);
  expect(Schema.is(InventoryEffectOutcomeDomainUnavailableProblemSchema)(unavailableProblem)).toBe(true);
  expect(Schema.is(CommitmentProtectionVerificationDomainConflictProblemSchema)(protectionConflict)).toBe(true);
  expect(JSON.stringify(unavailableProblem)).not.toContain('private database detail');
});
