import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { ActionHandlerContext, DataAccessEventInput } from '@app/core-runtime';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

import {
  InventorySourceImportActionInvocationIdSchema,
  InventorySourceImportUnavailable,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import type {
  InventorySourceImportLedgerEntry,
  InventorySourceImportLedgerPersistence,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import {
  InventorySourceAssertionRejected,
  InventorySourceAssertionProposalSchema,
  InventorySourceAssertionSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  handleImportSourceAssertion,
  importSourceAssertionAction,
} from '../../src/actions/import-source-assertion.action.ts';
import { makeInventorySourceImportService } from '../../src/services/inventory-source-import.service.ts';
import type { InventorySourceImportOperations } from '../../src/services/inventory-source-import.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const itemCorrelationId = '66666666-6666-4666-8666-666666666666';
const locationCorrelationId = '77777777-7777-4777-8777-777777777777';
const customerConfigurationId = 'customer-configuration:primary';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const positionRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
};
const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId: '88888888-8888-4888-8888-888888888888',
  customerConfigurationId,
  revision: 1,
  selectedAt: '2026-09-24T09:00:00.000Z',
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-a',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'UNSUPPORTED',
  },
  tenantId,
});

const uuidFor = (value: number) => `99999999-9999-4999-8999-${String(value).padStart(12, '0')}`;
const decodeProposal = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema, { onExcessProperty: 'error' });
const proposal = (revision: number, input?: Partial<typeof InventorySourceAssertionProposalSchema.Encoded>) =>
  decodeProposal({
    assertionId: uuidFor(revision),
    businessObservedAt: `2026-09-24T10:${String(revision % 60).padStart(2, '0')}:00.000Z`,
    coverage: [],
    customerConfigurationId,
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    itemExternalKey: {
      customerConfigurationId,
      externalScope: 'warehouse:prague',
      externalValue: 'ITEM-123',
      identifierKind: 'ITEM',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    locationExternalKey: {
      customerConfigurationId,
      externalScope: 'warehouse:prague',
      externalValue: 'LOC-123',
      identifierKind: 'LOCATION',
      issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
      namespace: 'inventory',
      tenantId,
    },
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: String(revision) },
    ownerEvidenceRef: `erp-a:snapshot:${revision}`,
    positionRef,
    quantity: { amount: String(revision), unitRef },
    receivedAt: '2026-09-24T12:00:00.000Z',
    sourceReference: `erp-a:warehouse:prague:snapshot:${revision}`,
    ...input,
  });

const assertionFor = (candidate: ReturnType<typeof proposal>) =>
  Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
    ...candidate,
    authorityConfiguration: configuration,
    issuerAuthority: 'SELECTED_BACKEND',
    itemCorrelationRef: {
      moduleId: 'commerce.inventory',
      resourceId: itemCorrelationId,
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    locationCorrelationRef: {
      moduleId: 'commerce.inventory',
      resourceId: locationCorrelationId,
      resourceType: 'commerce.inventory.external-stock-correlation',
      tenantId,
    },
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: itemId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    stockLocationRef: {
      moduleId: 'commerce.inventory',
      resourceId: locationId,
      resourceType: 'commerce.inventory.stock-location',
      tenantId,
    },
  });

/* oxlint-disable sonarjs/no-nested-functions -- In-memory owner port keeps service behavior observable at its public seam; expires: 2027-03-31. */
const makeLedger = (seed: readonly InventorySourceImportLedgerEntry[] = []) =>
  Effect.gen(function* makeMemoryLedger() {
    const entries = yield* Ref.make(seed);
    const ledger: InventorySourceImportLedgerPersistence = {
      append: (entry) => Ref.update(entries, (current) => [...current, entry]).pipe(Effect.as(entry)),
      findByInvocationItem: (actionInvocationId, itemIndex) =>
        Ref.get(entries).pipe(
          Effect.map((current) =>
            Option.fromNullishOr(
              current.find((entry) => entry.actionInvocationId === actionInvocationId && entry.itemIndex === itemIndex),
            ),
          ),
        ),
      lockAndReadAcceptedHistory: () =>
        Ref.get(entries).pipe(Effect.map((current) => current.filter((entry) => entry.outcome.status === 'ACCEPTED'))),
    };
    return { entries, ledger };
  });
/* oxlint-enable sonarjs/no-nested-functions */

const determinate = (candidate: ReturnType<typeof proposal>) => ({
  _tag: 'DETERMINATE' as const,
  assertion: assertionFor(candidate),
  postEffectOnHand: candidate.quantity,
  reconciliationRequired: false as const,
});

const actionId = Schema.decodeSync(InventorySourceImportActionInvocationIdSchema)(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
);
const actionIdFor = (value: number) => Schema.decodeSync(InventorySourceImportActionInvocationIdSchema)(uuidFor(value));

describe('Inventory source import service', () => {
  it('requires Inventory Migration permission for the batch exact Position target', () => {
    const first = proposal(1);
    const payload = Schema.decodeUnknownSync(importSourceAssertionAction.descriptor.payloadSchema)({
      authorizationTargetRef: first.positionRef,
      items: [first],
    });
    const scope = trustVerifiedGatewayPrincipalContext({
      authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      authContextRef: 'test:inventory-source-import',
      authMethod: 'api_key',
      correlationId: 'inventory-source-import',
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      tenantId,
    });

    expect(getActionBusinessPermissionTargetResolver(importSourceAssertionAction)?.(payload, scope)).toEqual({
      permission: 'inventory.migration.manage',
      target: {
        kind: 'inventory_resource',
        resource: {
          moduleId: first.positionRef.moduleId,
          resourceId: first.positionRef.resourceId,
          resourceType: first.positionRef.resourceType,
        },
        tenantId,
      },
    });
  });

  it('rejects mixed Position targets before entering the Action lifecycle', () => {
    const first = proposal(1);
    const second = proposal(2, {
      positionRef: { ...first.positionRef, resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3' },
    });

    expect(() =>
      Schema.decodeUnknownSync(importSourceAssertionAction.descriptor.payloadSchema)({
        authorizationTargetRef: first.positionRef,
        items: [first, second],
      }),
    ).toThrow();
  });

  it('exposes one idempotent tenant Action whose typed result preserves per-item cardinality', () => {
    expect(importSourceAssertionAction.descriptor).toMatchObject({
      actionKey: 'commerce.inventory.import-source-assertion',
      entrypoint: {
        authorization: { kind: 'action_execution', provisioning: 'explicit' },
        scope: 'tenant',
      },
      idempotency: 'required',
      legalEntityScope: 'forbidden',
    });
    const candidate = proposal(1);
    const payload = Schema.decodeUnknownSync(importSourceAssertionAction.descriptor.payloadSchema)({
      authorizationTargetRef: candidate.positionRef,
      items: [candidate],
    });
    const result = Schema.decodeUnknownSync(importSourceAssertionAction.descriptor.resultSchema)({
      items: [{ assertionId: candidate.assertionId, postEffectOnHand: candidate.quantity, status: 'ACCEPTED' }],
      summary: {
        accepted: 1,
        allItemsDeterminate: true,
        duplicates: 0,
        indeterminate: 0,
        rejected: 0,
        stale: 0,
      },
    });

    expect(result.items).toHaveLength(payload.items.length);
  });

  it.effect('records one bounded Data Access event per unique Position after a successful mixed/replay result', () =>
    Effect.gen(function* actionDataAccess() {
      const first = proposal(1);
      const retry = proposal(2);
      const accesses: DataAccessEventInput[] = [];
      const expected = {
        items: [
          { assertionId: first.assertionId, postEffectOnHand: first.quantity, status: 'ACCEPTED' as const },
          {
            assertionId: retry.assertionId,
            duplicateOfAssertionId: first.assertionId,
            reason: 'already accepted',
            status: 'DUPLICATE' as const,
          },
        ],
        summary: {
          accepted: 1,
          allItemsDeterminate: true,
          duplicates: 1,
          indeterminate: 0,
          rejected: 0,
          stale: 0,
        },
      };
      const context: ActionHandlerContext<Readonly<Record<never, never>>, InventorySourceImportOperations> = {
        actionInvocationId: actionId,
        addDomainEvent: () => Effect.die(new Error('unexpected domain event')),
        addOutboxMessage: () => Effect.die(new Error('unexpected outbox message')),
        recordAuditEvidence: () => Effect.die(new Error('unexpected audit evidence')),
        recordDataAccess: (access) =>
          Effect.sync(() => {
            accesses.push(access);
          }),
        scope: trustVerifiedGatewayPrincipalContext({
          authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          authContextRef: 'test:inventory-source-import-handler',
          authMethod: 'api_key',
          correlationId: 'inventory-source-import-handler',
          principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          tenantId,
        }),
        services: { importBatch: () => Effect.succeed(expected) },
      };

      const result = yield* handleImportSourceAssertion(
        { authorizationTargetRef: first.positionRef, items: [first, retry] },
        context,
      );

      expect(result).toEqual(expected);
      expect(accesses).toEqual([
        {
          accessKind: 'read',
          queryHash: `inventory-source-import:${positionId}`,
          resultCount: 2,
          servingModuleKey: 'commerce.inventory',
          targetModuleKey: 'commerce.inventory',
          targetResourceId: positionId,
          targetResourceType: 'commerce.inventory.stock-position',
        },
      ]);
    }),
  );

  it.effect('keeps an older late delivery stale without evaluating or applying it again', () =>
    Effect.gen(function* staleDelivery() {
      const newer = proposal(2);
      const { ledger } = yield* makeLedger(
        [
          {
            actionInvocationId: actionId,
            itemIndex: 0,
            outcome: { ...determinate(newer), status: 'ACCEPTED' },
            proposal: newer,
          },
        ].map((entry) => ({
          ...entry,
          outcome: {
            assertionId: entry.proposal.assertionId,
            postEffectOnHand: entry.proposal.quantity,
            status: 'ACCEPTED' as const,
          },
        })),
      );
      let evaluations = 0;
      const service = makeInventorySourceImportService({
        configurations: { findCurrent: () => Effect.succeed(Option.some(configuration)) },
        evaluator: {
          evaluate: (input) =>
            Effect.sync(() => {
              evaluations += 1;
              return determinate(input.proposal);
            }),
        },
        ledger,
      });

      const result = yield* service.importBatch({
        actionInvocationId: actionIdFor(500),
        payload: { authorizationTargetRef: positionRef, items: [proposal(1)] },
      });

      expect(result.items).toMatchObject([{ status: 'STALE' }]);
      expect(evaluations).toBe(0);
    }),
  );

  it.effect('keeps changed material at the same source revision indeterminate and leaves Current untouched', () =>
    Effect.gen(function* integrityConflict() {
      const accepted = proposal(2);
      const { ledger } = yield* makeLedger([
        {
          actionInvocationId: actionId,
          itemIndex: 0,
          outcome: { assertionId: accepted.assertionId, postEffectOnHand: accepted.quantity, status: 'ACCEPTED' },
          proposal: accepted,
        },
      ]);
      let evaluations = 0;
      const service = makeInventorySourceImportService({
        configurations: { findCurrent: () => Effect.succeed(Option.some(configuration)) },
        evaluator: {
          evaluate: () =>
            Effect.sync(() => {
              evaluations += 1;
              return determinate(accepted);
            }),
        },
        ledger,
      });
      const changed = proposal(2, { assertionId: uuidFor(202), quantity: { amount: '12', unitRef } });

      const result = yield* service.importBatch({
        actionInvocationId: actionIdFor(501),
        payload: { authorizationTargetRef: positionRef, items: [changed] },
      });

      expect(result.items).toMatchObject([{ reconciliationRequired: true, status: 'INDETERMINATE' }]);
      expect(evaluations).toBe(0);
    }),
  );

  it.effect('returns one ordered outcome per item and accepts valid items beside semantic failures', () =>
    Effect.gen(function* partialBatch() {
      const { entries, ledger } = yield* makeLedger();
      const items = Array.from({ length: 100 }, (_, index) => proposal(index + 1));
      const rejectedId = items[98]?.assertionId;
      const indeterminateId = items[99]?.assertionId;
      const service = makeInventorySourceImportService({
        configurations: { findCurrent: () => Effect.succeed(Option.some(configuration)) },
        evaluator: {
          evaluate: ({ proposal: candidate }) => {
            if (candidate.assertionId === rejectedId) {
              return Effect.fail(
                new InventorySourceAssertionRejected({
                  assertionId: candidate.assertionId,
                  code: 'inventory_source_assertion_rejected',
                  reason: 'POSITION_SCOPE_MISMATCH',
                }),
              );
            }
            if (candidate.assertionId === indeterminateId) {
              return Effect.succeed({
                _tag: 'INDETERMINATE' as const,
                assertion: assertionFor(candidate),
                materialEffectIds: [],
                postEffectOnHand: null,
                reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN' as const,
                reconciliationRequired: true as const,
              });
            }
            return Effect.succeed(determinate(candidate));
          },
        },
        ledger,
      });

      const result = yield* service.importBatch({
        actionInvocationId: actionIdFor(502),
        payload: { authorizationTargetRef: positionRef, items },
      });

      expect(result.items).toHaveLength(100);
      expect(result.items.slice(0, 98).every(({ status }) => status === 'ACCEPTED')).toBe(true);
      expect(result.items.slice(98).map(({ status }) => status)).toEqual(['REJECTED', 'INDETERMINATE']);
      expect(result.summary).toEqual({
        accepted: 98,
        allItemsDeterminate: false,
        duplicates: 0,
        indeterminate: 1,
        rejected: 1,
        stale: 0,
      });
      expect(yield* Ref.get(entries)).toHaveLength(100);
    }),
  );

  it.effect('treats a retry under a new Action invocation as a duplicate without a second evaluation', () =>
    Effect.gen(function* exactRetry() {
      const { ledger } = yield* makeLedger();
      let evaluations = 0;
      const service = makeInventorySourceImportService({
        configurations: { findCurrent: () => Effect.succeed(Option.some(configuration)) },
        evaluator: {
          evaluate: ({ proposal: candidate }) =>
            Effect.sync(() => {
              evaluations += 1;
              return determinate(candidate);
            }),
        },
        ledger,
      });
      const candidate = proposal(1);

      const first = yield* service.importBatch({
        actionInvocationId: actionIdFor(601),
        payload: { authorizationTargetRef: positionRef, items: [candidate] },
      });
      const retry = yield* service.importBatch({
        actionInvocationId: actionIdFor(602),
        payload: { authorizationTargetRef: positionRef, items: [candidate] },
      });

      expect(first.items).toMatchObject([{ status: 'ACCEPTED' }]);
      expect(retry.items).toMatchObject([{ duplicateOfAssertionId: candidate.assertionId, status: 'DUPLICATE' }]);
      expect(evaluations).toBe(1);
    }),
  );

  it.effect('fails the operation when durable ledger persistence is unavailable', () =>
    Effect.gen(function* persistenceFailure() {
      const failure = new InventorySourceImportUnavailable({
        code: 'inventory_source_import_unavailable',
        reason: 'Inventory Source Import persistence is temporarily unavailable',
        retryable: true,
      });
      const { ledger: base } = yield* makeLedger();
      const service = makeInventorySourceImportService({
        configurations: { findCurrent: () => Effect.succeed(Option.some(configuration)) },
        evaluator: { evaluate: ({ proposal: candidate }) => Effect.succeed(determinate(candidate)) },
        ledger: { ...base, append: () => Effect.fail(failure) },
      });

      const observed = yield* service
        .importBatch({
          actionInvocationId: actionIdFor(700),
          payload: { authorizationTargetRef: positionRef, items: [proposal(1)] },
        })
        .pipe(Effect.flip);

      expect(observed).toBe(failure);
    }),
  );
});
