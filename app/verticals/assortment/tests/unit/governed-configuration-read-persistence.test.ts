import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssortmentConfigurationRequestSchema } from '../../shared/domain/governed-read-contracts.ts';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';
import { ReadHandlerUnavailable } from '@app/core-runtime';
import {
  assortmentConfigurationReadService,
  assortmentConfigurationReadSourceForScope,
} from '../../src/services/governed-configuration-read.service.ts';
import { configurationReadPermissionTarget, readConfiguration } from '../../src/api/configuration.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'governed-configuration-persistence-test',
  authMethod: 'session',
  correlationId: 'governed-configuration-persistence-test',
  legalEntityId,
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId,
} satisfies OperationalScope;
const at = new Date('2026-09-23T09:00:00.000Z');
const resource = (resourceType: string, resourceId: string, ownerTenant = tenantId) =>
  Schema.decodeUnknownSync(AssortmentConfigurationRequestSchema)({
    resource: { moduleId: 'commerce.assortment', resourceId, resourceType, tenantId: ownerTenant },
  }).resource;
const query = <Rows extends readonly object[]>(rows: Rows | Effect.Effect<Rows, unknown>) => {
  const effect = (Effect.isEffect(rows) ? rows : Effect.succeed(rows)) as Effect.Effect<Rows> & {
    from: () => typeof effect;
    limit: () => typeof effect;
    where: () => typeof effect;
  };
  effect.from = () => effect;
  effect.limit = () => effect;
  effect.where = () => effect;
  return effect;
};
const transaction = (selects: readonly (readonly object[] | Effect.Effect<readonly object[], unknown>)[]) => {
  let index = 0;
  return {
    select: () => {
      const current = index;
      index += 1;
      return query(selects[current] ?? []);
    },
  } as unknown as ScopedTransactionExecutor;
};

const stableRow = {
  createdAt: at,
  stableCode: 'policy.example',
  stableRuleId: 'stable-rule-1',
  tenantId,
};
const revisionRow = {
  effect: 'ALLOW',
  purpose: 'PURCHASE',
  recordedAt: at,
  revisionNumber: 1,
  ruleRevisionId: 'rule-revision-1',
  selectorKind: 'ALL',
  semanticFingerprint: 'a'.repeat(64),
  tenantId,
};
const bindingRow = {
  applicabilityBindingId: 'binding-1',
  bindingKind: 'SHARED',
  channelResourceId: 'channel-1',
  customerGroupResourceId: null,
  effectiveFrom: at,
  legalEntityId,
  marketResourceId: null,
  ruleRevisionId: 'rule-revision-1',
  storefrontResourceId: null,
  subjectKind: null,
  subjectResourceId: null,
  tenantId,
};
const boundaryRow = {
  channelResourceId: 'channel-1',
  closedBoundaryId: 'boundary-1',
  effectiveFrom: at,
  legalEntityId,
  marketResourceId: null,
  purpose: 'PURCHASE',
  semanticFingerprint: 'b'.repeat(64),
  storefrontResourceId: null,
  subjectKind: 'COUNTERPARTY',
  subjectResourceId: 'counterparty-1',
  tenantId,
};

it.effect('loads each exact configuration resource and only its lifecycle evidence', () =>
  Effect.gen(function* exactConfigurationRows() {
    const source = assortmentConfigurationReadSourceForScope(transaction([[stableRow], [{ retiredAt: at }]]), scope);
    const rule = yield* source.resolve(
      Schema.decodeUnknownSync(AssortmentConfigurationRequestSchema)({
        resource: resource('commerce.assortment.stable-rule', 'stable-rule-1'),
      }).resource,
      scope,
    );
    expect(rule.configuration.kind).toStrictEqual('RULE');
    expect(rule.configuration.value).toHaveProperty('retiredAt');

    const revision = yield* assortmentConfigurationReadSourceForScope(transaction([[revisionRow]]), scope).resolve(
      resource('commerce.assortment.rule-revision', 'rule-revision-1'),
      scope,
    );
    expect(revision.configuration.kind).toStrictEqual('REVISION');

    const binding = yield* assortmentConfigurationReadSourceForScope(
      transaction([[bindingRow], [revisionRow], [{ effectiveTo: at }]]),
      scope,
    ).resolve(resource('commerce.assortment.applicability-binding', 'binding-1'), scope);
    expect(binding.configuration.kind).toStrictEqual('BINDING');
    expect(binding.configuration.value).toHaveProperty('effectiveTo');

    const boundary = yield* assortmentConfigurationReadSourceForScope(
      transaction([[boundaryRow], [{ effectiveTo: at }]]),
      scope,
    ).resolve(resource('commerce.assortment.closed-assortment-boundary', 'boundary-1'), scope);
    expect(boundary.configuration.kind).toStrictEqual('BOUNDARY');
    expect(boundary.configuration.value).not.toHaveProperty('admissionSet');
  }),
);

it.effect('preserves the stored selector owner and fails closed for unresolved legacy owners', () =>
  Effect.gen(function* selectorOwnerEvidence() {
    const catalogRevision = {
      ...revisionRow,
      selectorKind: 'PRODUCT',
      selectorTargetOwnerModuleId: 'commerce.catalog',
      selectorTargetResourceId: 'product-1',
      selectorTargetResourceType: 'catalog.product',
    };
    const catalogConfiguration = yield* assortmentConfigurationReadSourceForScope(
      transaction([[catalogRevision]]),
      scope,
    ).resolve(resource('commerce.assortment.rule-revision', 'rule-revision-1'), scope);
    expect(catalogConfiguration.configuration.kind).toBe('REVISION');
    if (catalogConfiguration.configuration.kind === 'REVISION') {
      expect(catalogConfiguration.configuration.value.selector).toEqual({
        kind: 'PRODUCT',
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'product-1',
          resourceType: 'catalog.product',
          tenantId,
        },
      });
    }

    const unresolved = yield* Effect.flip(
      assortmentConfigurationReadSourceForScope(
        transaction([[{ ...catalogRevision, selectorTargetOwnerModuleId: null }]]),
        scope,
      ).resolve(resource('commerce.assortment.rule-revision', 'legacy-revision'), scope),
    );
    expect(Schema.is(AssortmentPolicyPersistenceUnavailable)(unresolved)).toBe(true);
  }),
);

it.effect('fails closed for wrong tenant, missing resource, legal-entity mismatch, and database failure', () =>
  Effect.gen(function* failClosed() {
    const unavailable = assortmentConfigurationReadService(
      assortmentConfigurationReadSourceForScope(transaction([[]]), scope),
      scope,
    );
    const foreign = Schema.decodeUnknownSync(AssortmentConfigurationRequestSchema)({
      resource: resource(
        'commerce.assortment.rule-revision',
        'rule-revision-1',
        '90000000-0000-4000-8000-000000000009',
      ),
    });
    const foreignError = yield* Effect.flip(unavailable.read(foreign));
    expect(Schema.is(AssortmentPolicyPersistenceUnavailable)(foreignError)).toStrictEqual(true);

    const missing = yield* Effect.flip(
      assortmentConfigurationReadSourceForScope(transaction([[]]), scope).resolve(
        resource('commerce.assortment.rule-revision', 'missing'),
        scope,
      ),
    );
    expect(Schema.is(AssortmentPolicyPersistenceUnavailable)(missing)).toStrictEqual(true);

    const dbFailure = yield* Effect.flip(
      assortmentConfigurationReadSourceForScope(
        transaction([Effect.fail(new Error('database unavailable'))]),
        scope,
      ).resolve(resource('commerce.assortment.rule-revision', 'revision-1'), scope),
    );
    expect(Schema.is(AssortmentPolicyPersistenceUnavailable)(dbFailure)).toStrictEqual(true);

    const target = configurationReadPermissionTarget(
      Schema.decodeUnknownSync(AssortmentConfigurationRequestSchema)({
        resource: resource('commerce.assortment.rule-revision', 'revision-1'),
      }),
      scope,
    );
    expect(target.kind).toStrictEqual('assortment_permission');
    expect(target.assortmentPermission.resource.resourceType).toStrictEqual('commerce.assortment.rule-revision');

    const handlerResult = yield* Effect.flip(
      readConfiguration(
        Schema.decodeUnknownSync(AssortmentConfigurationRequestSchema)({
          resource: resource('commerce.assortment.rule-revision', 'revision-1'),
        }),
        {
          readKey: 'commerce.assortment.api.configuration',
          scope,
          services: { configuration: unavailable },
        },
      ),
    );
    expect(Schema.is(ReadHandlerUnavailable)(handlerResult)).toStrictEqual(true);
  }),
);
