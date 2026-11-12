import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { RegisteredGatewayRecoverySchema } from '@app/core-runtime/auth/system-principal-context-provenance';
import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { assert, describe, expect, it } from 'effect-rstest';
import type { InventorySourceAssertionProposal } from '../../shared/domain/inventory-source-assertion.ts';
import { InventorySourceImportReceiptResponseSchema } from '../../shared/apis/inventory-source-import-receipt.ts';
import { InventorySourceAssertionProposalSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { InventorySourceImportLedgerEntrySchema } from '../../shared/domain/inventory-source-import-outcome.ts';
import { importSourceAssertionAction } from '../../src/actions/import-source-assertion.action.ts';
import {
  inventorySourceImportReceiptHandler,
  inventorySourceImportReceiptRead,
  matchesInventorySourceImportReceiptRecovery,
} from '../../src/api/inventory-source-import-receipt.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actionInvocationId = '22222222-2222-4222-8222-222222222222';
const assertionId = '33333333-3333-4333-8333-333333333333';
const proposal = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema)({
  assertionId,
  businessObservedAt: '2026-09-24T10:00:00.000Z',
  coverage: [],
  customerConfigurationId: 'customer-configuration:primary',
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
  itemExternalKey: {
    customerConfigurationId: 'customer-configuration:primary',
    externalScope: 'warehouse:prague',
    externalValue: 'ITEM-123',
    identifierKind: 'ITEM',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  locationExternalKey: {
    customerConfigurationId: 'customer-configuration:primary',
    externalScope: 'warehouse:prague',
    externalValue: 'LOC-123',
    identifierKind: 'LOCATION',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
  ownerEvidenceRef: 'erp-a:snapshot:42',
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  quantity: {
    amount: '8',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  receivedAt: '2026-09-24T12:00:00.000Z',
  sourceReference: 'erp-a:warehouse:prague:snapshot:42',
});
const outcome = { assertionId, postEffectOnHand: proposal.quantity, status: 'ACCEPTED' as const };
const entry = Schema.decodeUnknownSync(InventorySourceImportLedgerEntrySchema)({
  actionInvocationId,
  itemIndex: 0,
  outcome,
  proposal,
});

const context = (receipt = Option.some(entry)) => ({
  scope: { tenantId },
  services: { findOriginal: () => Effect.succeed(receipt) },
});
const read = (input: InventorySourceAssertionProposal = proposal, receipt = Option.some(entry)) =>
  inventorySourceImportReceiptHandler(
    { actionInvocationId: entry.actionInvocationId, itemIndex: 0, proposal: input },
    context(receipt),
  );

describe('Inventory source import original receipt', () => {
  it.effect('recovers the original accepted outcome after the response was lost', () =>
    Effect.gen(function* recoverOriginal() {
      const result = yield* read();
      assert(Schema.is(InventorySourceImportReceiptResponseSchema.members[0])(result.result));
      expect(result.result.receipt).toEqual(entry);
      expect(result.evidence.resultCount).toBe(1);
    }),
  );
  it.effect('never turns a missing original outcome into safe permission to resubmit', () =>
    Effect.gen(function* missingOriginal() {
      const result = yield* read(proposal, Option.none());
      assert(Schema.is(InventorySourceImportReceiptResponseSchema.members[1])(result.result));
      expect(result.result).toMatchObject({
        assertionId: proposal.assertionId,
        reason: 'ORIGINAL_SOURCE_IMPORT_NOT_RESOLVED',
        retryCommand: false,
      });
      expect(result.evidence.resultCount).toBe(0);
    }),
  );
  it.effect('rejects retargeted source, backend, Unit, time, quantity and ordering material', () =>
    Effect.gen(function* changedMaterial() {
      const changed: readonly InventorySourceAssertionProposal[] = [
        { ...proposal, sourceReference: 'changed-source' },
        {
          ...proposal,
          issuer: {
            ...proposal.issuer,
            backendId: InventorySourceAssertionProposalSchema.fields.issuer.fields.backendId.make('erp-b'),
          },
        },
        { ...proposal, positionRef: { ...proposal.positionRef, resourceId: '66666666-6666-4666-8666-666666666666' } },
        {
          ...proposal,
          quantity: {
            ...proposal.quantity,
            amount: InventorySourceAssertionProposalSchema.fields.quantity.fields.amount.make('999'),
          },
        },
        {
          ...proposal,
          quantity: {
            ...proposal.quantity,
            unitRef: { ...proposal.quantity.unitRef, resourceId: '66666666-6666-4666-8666-666666666666' },
          },
        },
        { ...proposal, businessObservedAt: '2026-09-25T10:00:00.000Z' },
        { ...proposal, orderingEvidence: { _tag: 'SOURCE_REVISION' as const, revision: '43' } },
      ];
      for (const input of changed) {
        const result = yield* read(input);
        expect(Schema.is(InventorySourceImportReceiptResponseSchema.members[1])(result.result)).toBe(true);
      }
    }),
  );
  it.effect('does not let a changed arrival time rewrite original provenance', () =>
    Effect.gen(function* preserveArrival() {
      const result = yield* read({ ...proposal, receivedAt: '2026-09-25T12:00:00.000Z' });
      assert(Schema.is(InventorySourceImportReceiptResponseSchema.members[0])(result.result));
      expect(result.result.receipt).toEqual(entry);
    }),
  );
  it.effect('refuses cross-Tenant access before resolving private receipts', () =>
    Effect.gen(function* crossTenant() {
      const result = yield* read({
        ...proposal,
        positionRef: { ...proposal.positionRef, tenantId: '66666666-6666-4666-8666-666666666666' },
      }).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(result)).toBe(true);
    }),
  );
  it.effect('keeps another invocation or row index unresolved', () =>
    Effect.gen(function* exactReceiptIdentity() {
      for (const identity of [
        {
          actionInvocationId: InventorySourceImportLedgerEntrySchema.fields.actionInvocationId.make(
            '66666666-6666-4666-8666-666666666666',
          ),
          itemIndex: 0,
        },
        { actionInvocationId: entry.actionInvocationId, itemIndex: 1 },
      ]) {
        const result = yield* inventorySourceImportReceiptHandler({ ...identity, proposal }, context());
        expect(Schema.is(InventorySourceImportReceiptResponseSchema.members[1])(result.result)).toBe(true);
      }
    }),
  );
  it.effect('keeps unavailable receipt storage distinct from absent or zero stock', () =>
    Effect.gen(function* unavailableReceipt() {
      const failure = new ReadHandlerUnavailable({
        code: 'read_handler_unavailable',
        reason: 'Internal fixture outage',
      });
      const result = yield* inventorySourceImportReceiptHandler(
        { actionInvocationId: entry.actionInvocationId, itemIndex: 0, proposal },
        { scope: { tenantId }, services: { findOriginal: () => Effect.fail(failure) } },
      ).pipe(Effect.flip);
      expect(result).toBe(failure);
    }),
  );
  it('publishes only the exact source write and receipt read workload paths alongside human permissions', () => {
    expect(importSourceAssertionAction.descriptor.accessWorkload?.workloads).toEqual([
      'commerce.inventory.source-write',
    ]);
    expect(inventorySourceImportReceiptRead.descriptor.accessWorkload?.workloads).toEqual([
      'commerce.inventory.source-read',
    ]);
    expect(importSourceAssertionAction.descriptor.accessDeclaration?.key).toBe(
      'commerce.inventory.source-assertion.import',
    );
    expect(inventorySourceImportReceiptRead.descriptor.accessDeclaration?.key).toBe(
      'commerce.inventory.inventory-source-import-receipt.read',
    );
  });
  it('matches only the exact signed original invocation, Action and canonical Read input', () => {
    const input = { actionInvocationId: entry.actionInvocationId, itemIndex: 0, proposal };
    // Inert matching input only: this creates no Principal or trusted gateway provenance.
    const claim = Schema.decodeUnknownSync(RegisteredGatewayRecoverySchema)({
      originalActionInvocationId: entry.actionInvocationId,
      originalActionKey: 'commerce.inventory.import-source-assertion',
      originalAuthContextRef: 'internal-original-system-writer',
      originalIdempotencyKey: 'internal-source-write-1',
      originalPrincipalId: '77777777-7777-4777-8777-777777777777',
      originalRequestHash: 'a'.repeat(64),
      requestHash: computeCanonicalValueHash(input),
    });
    expect(matchesInventorySourceImportReceiptRecovery(input, claim)).toBe(true);
    expect(matchesInventorySourceImportReceiptRecovery({ ...input, itemIndex: 1 }, claim)).toBe(false);
    expect(
      matchesInventorySourceImportReceiptRecovery(input, {
        ...claim,
        originalActionInvocationId: RegisteredGatewayRecoverySchema.fields.originalActionInvocationId.make(
          '88888888-8888-4888-8888-888888888888',
        ),
      }),
    ).toBe(false);
    expect(
      matchesInventorySourceImportReceiptRecovery(input, {
        ...claim,
        originalActionKey: RegisteredGatewayRecoverySchema.fields.originalActionKey.make(
          'commerce.inventory.stock-receipt',
        ),
      }),
    ).toBe(false);
    expect(matchesInventorySourceImportReceiptRecovery(input, { ...claim, requestHash: 'b'.repeat(64) })).toBe(false);
  });
  it('binds authorization to the original Stock Position and excludes legal entity scope', () => {
    expect(inventorySourceImportReceiptRead.descriptor.legalEntityScope).toBe('forbidden');
    expect(inventorySourceImportReceiptRead.descriptor.entrypoint.authorization.kind).toBe('protected');
  });
});
