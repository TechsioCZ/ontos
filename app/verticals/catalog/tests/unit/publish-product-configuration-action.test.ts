import type { ActionHandlerContext } from '@app/core-runtime';
import { ActionTransactionError, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  getActionDecodedSuccessHook,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';

/* oxlint-disable sonarjs/no-nested-functions -- Scoped snapshot query mocks mirror the transactional insert chain. owner: Catalog #478; remove with a shared transaction fixture. expires: 2027-03-31. */

import {
  PublishProductConfigurationPayloadSchema,
  PublishProductConfigurationError,
} from '../../shared/actions/publish-product-configuration.ts';
import { mapPublishProductConfigurationActionProblem } from '../../api/publish-product-configuration-action-problems.ts';
import {
  handlePublishProductConfiguration,
  publishProductConfigurationAction,
} from '../../src/actions/publish-product-configuration.action.ts';
import type { ProductConfigurationPersistence } from '../../src/persistence/product-configuration-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';
import { catalogResultSnapshots } from '../../src/database/schema.ts';
import type { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-product-configuration-published-v1.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const payload = Schema.decodeUnknownSync(PublishProductConfigurationPayloadSchema)({
  choices: [
    {
      choiceKey: 'length',
      kind: 'MEASURED_VALUE',
      label: 'Length',
      meaning: 'Exact length',
      required: true,
      unitId: 'cm',
    },
  ],
  compatibilityRules: [],
  definitionId: 'definition-1',
  effectiveFrom: new Date('2026-09-18T00:00:00.000Z'),
  evidenceRefs: ['document-1'],
  expectedRevision: 0,
  measuredRules: [{ choiceKey: 'length', evidenceRefs: ['document-1'], minimum: '0', minimumInclusive: true }],
  optionAllowances: [],
  productId: 'product-1',
  reason: 'Initial publication',
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:configuration-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'configuration-test',
};
const context = (
  services: ProductConfigurationPersistence,
): ActionHandlerContext<
  { 'commerce.catalog.product-configuration-published.v1': typeof OutboxPayloadSchema },
  ProductConfigurationPersistence
> => ({
  actionInvocationId: '33333333-3333-4333-8333-333333333333',
  addDomainEvent: () => Effect.succeed(Object.create(null)),
  addOutboxMessage: () => Effect.void,
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services,
});

describe('Product Configuration publication Action', () => {
  it.effect('rolls back the Action commit when publication result capture fails', () =>
    Effect.gen(function* rejectPublicationCommit() {
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(publishProductConfigurationAction, {
            captureResult: () =>
              Effect.fail(
                Object.assign(
                  new ActionTransactionError({
                    code: 'action_transaction_failed',
                    reason: 'Catalog result capture failed',
                  }),
                  {
                    cause: new CatalogPersistenceUnavailable({
                      code: 'catalog_persistence_unavailable',
                      reason: 'snapshot storage unavailable',
                    }),
                  },
                ),
              ),
            publish: () => Effect.succeed({ _tag: 'published' as const, revision: 1 }),
            readCurrent: () => Effect.die('unexpected read'),
          }),
        ],
      });
      const failure = yield* harness.runtime
        .runAction({
          payload,
          principal: {
            authBindingId: '44444444-4444-4444-8444-444444444444',
            authContextRef: 'better-auth-session:configuration-capture',
            authMethod: 'session',
            principalId,
            tenantId,
          },
          registration: publishProductConfigurationAction,
          transport: { correlationId: 'configuration-capture', idempotencyKey: 'configuration-capture-failure' },
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      expect(harness.snapshot().committed).toHaveLength(0);
    }),
  );

  it.effect('captures the decoded publication result with its exact Action identity in the scoped transaction', () =>
    Effect.gen(function* capturePublicationResult() {
      const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
      const transaction = {
        insert: (table: typeof catalogResultSnapshots) => {
          expect(table).toBe(catalogResultSnapshots);
          return {
            values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
              onConflictDoNothing: () => ({
                returning: () =>
                  Effect.sync(() => {
                    rows.push(row);
                    return [row];
                  }),
              }),
            }),
          };
        },
      };
      // @ts-expect-error Focused transaction mock implements only the snapshot insert chain.
      const services = yield* getActionServiceFactory(publishProductConfigurationAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(publishProductConfigurationAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        yield* hook({
          actionInvocationId: '33333333-3333-4333-8333-333333333333',
          result: { definitionId: payload.definitionId, revision: 1 },
          scope,
          services,
        });
      }
      expect(rows).toEqual([
        expect.objectContaining({
          actingPrincipalId: principalId,
          actionInvocationId: '33333333-3333-4333-8333-333333333333',
          actionKey: 'commerce.catalog.publish-product-configuration',
          encodedResult: { definitionId: payload.definitionId, revision: 1 },
          schemaVersion: 1,
          tenantId,
        }),
      ]);
    }),
  );

  it.effect('fails the decoded-success hook when transactional snapshot storage fails', () =>
    Effect.gen(function* rejectPublicationResult() {
      const transaction = {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: () => ({ returning: () => Effect.fail(new Error('snapshot storage unavailable')) }),
          }),
        }),
      };
      // @ts-expect-error Focused transaction mock implements only the failing snapshot insert chain.
      const services = yield* getActionServiceFactory(publishProductConfigurationAction)(transaction, scope);
      const hook = getActionDecodedSuccessHook(publishProductConfigurationAction);
      expect(hook).toBeDefined();
      if (hook !== undefined) {
        const failure = yield* hook({
          actionInvocationId: '33333333-3333-4333-8333-333333333333',
          result: { definitionId: payload.definitionId, revision: 1 },
          scope,
          services,
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: 'action_transaction_failed' });
      }
    }),
  );

  it('is an explicit governed write with no caller principal', () => {
    expect(publishProductConfigurationAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(publishProductConfigurationAction.descriptor.legalEntityScope).toBe('forbidden');
    expect('principalId' in payload).toBe(false);
  });

  it.effect('passes trusted principal, invocation, and exact CAS basis to persistence', () =>
    Effect.gen(function* verifyTrustedPublication() {
      const services: ProductConfigurationPersistence = {
        publish: (input) =>
          Effect.sync(() => {
            expect(input.principalId).toBe(principalId);
            expect(input.actionInvocationId).toBe('33333333-3333-4333-8333-333333333333');
            expect(input.expectedRevision).toBe(0);
            expect(input.effectiveFrom.toISOString()).toBe('2026-09-18T00:00:00.000Z');
            return { _tag: 'published' as const, revision: 1 };
          }),
        readCurrent: () => Effect.die('unexpected read'),
      };
      expect(yield* handlePublishProductConfiguration(payload, context(services))).toEqual({
        definitionId: 'definition-1',
        revision: 1,
      });
    }),
  );

  it('maps stale, invalid, and unavailable distinctly', () => {
    for (const [code, status] of [
      ['product_configuration_stale', 409],
      ['product_configuration_invalid', 422],
      ['product_configuration_unavailable', 503],
    ] as const) {
      expect(
        mapPublishProductConfigurationActionProblem(new PublishProductConfigurationError({ code, reason: 'safe' }))
          .status,
      ).toBe(status);
    }
  });
});
