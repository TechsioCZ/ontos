import { assortmentOwnerPermissionTarget } from '../../src/permissions/authorization.ts';
import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  AssortmentPermissionTargetSchema,
  assortmentPermissionTargetIsValid,
  toAssortmentPermissionAccessKey,
  toAssortmentPermissionAccessObjectId,
} from '../../src/permissions/authorization-targets.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const assortmentEndTarget = {
  binding: {
    moduleId: 'commerce.assortment',
    resourceId: 'binding-1',
    resourceType: 'commerce.assortment.applicability-binding',
  },
  kind: 'assortment_binding' as const,
  mode: 'end' as const,
  permission: 'assortment.binding.end' as const,
};

const configurationTarget = (resourceType: string) => ({
  kind: 'assortment_configuration' as const,
  permission: 'assortment.configuration.read' as const,
  resource: { moduleId: 'commerce.assortment', resourceId: 'resource-1', resourceType },
});

it('uses tenant scope for Rule lineage and requires Legal Entity scope for binding lineage', () => {
  const ruleTarget = {
    effect: 'ALLOW' as const,
    kind: 'assortment_rule' as const,
    mode: 'create' as const,
    permission: 'assortment.rule.create' as const,
    purpose: 'PURCHASE' as const,
    selector: { kind: 'ALL' as const },
    stableCode: 'rule-1',
  };
  expect(toAssortmentPermissionAccessKey(tenantId, undefined, ruleTarget)).toBeDefined();
  expect(toAssortmentPermissionAccessObjectId(tenantId, undefined, ruleTarget)).toBeDefined();
  expect(toAssortmentPermissionAccessKey(tenantId, undefined, assortmentEndTarget)).toBeUndefined();
  expect(toAssortmentPermissionAccessObjectId(tenantId, undefined, assortmentEndTarget)).toBeUndefined();
  expect({
    bindingKey: toAssortmentPermissionAccessKey(tenantId, legalEntityId, assortmentEndTarget),
    bindingObjectId: toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, assortmentEndTarget),
    ruleKey: toAssortmentPermissionAccessKey(tenantId, undefined, ruleTarget),
    ruleObjectId: toAssortmentPermissionAccessObjectId(tenantId, undefined, ruleTarget),
    selectedLegalEntityRuleObjectId: toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, ruleTarget),
  }).toMatchInlineSnapshot(`
    {
      "bindingKey": "10000000-0000-4000-8000-000000000001:legal_entity:20000000-0000-4000-8000-000000000001:assortment.binding.end:assortment_binding:end:commerce.assortment:commerce.assortment.applicability-binding:binding-1",
      "bindingObjectId": "asp_8c96c0bcfaa64fd77def9d8a0bf460af9df9efc83d8bcfadd1ff4b47d7c51e11",
      "ruleKey": "10000000-0000-4000-8000-000000000001:tenant:assortment.rule.create:assortment_rule:create:PURCHASE:ALLOW:rule-1:ALL:none",
      "ruleObjectId": "asp_f68c2de924a061e3d6938d39204d2dbbd8987aa63dc6b2a4e6bc90c25bab0fa0",
      "selectedLegalEntityRuleObjectId": "asp_f68c2de924a061e3d6938d39204d2dbbd8987aa63dc6b2a4e6bc90c25bab0fa0",
    }
  `);
});

it('keeps configuration scope tied to the four canonical Assortment resource types', () => {
  for (const resourceType of ['commerce.assortment.stable-rule', 'commerce.assortment.rule-revision']) {
    const requested = configurationTarget(resourceType);
    expect(toAssortmentPermissionAccessKey(tenantId, undefined, requested)).toBeDefined();
    expect(toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, requested)).toBe(
      toAssortmentPermissionAccessObjectId(tenantId, undefined, requested),
    );
  }
  for (const resourceType of [
    'commerce.assortment.applicability-binding',
    'commerce.assortment.closed-assortment-boundary',
  ]) {
    expect(
      toAssortmentPermissionAccessObjectId(tenantId, undefined, configurationTarget(resourceType)),
    ).toBeUndefined();
    expect(
      toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, configurationTarget(resourceType)),
    ).toBeDefined();
  }
  expect(
    toAssortmentPermissionAccessObjectId(
      tenantId,
      legalEntityId,
      configurationTarget('commerce.assortment.configuration'),
    ),
  ).toBeUndefined();
});

it('retains complete Admission Set identity and rejects malformed or incompatible selectors', () => {
  const target = {
    admissionSet: {
      contentHash: 'a'.repeat(64),
      entries: [] as const,
      memberCount: 0 as const,
      setKind: 'EMPTY' as const,
    },
    commercialScope: { channel: { moduleId: 'commerce.channel', resourceId: 'web', resourceType: 'commerce.channel' } },
    effectiveFrom: '2026-09-22T00:00:00.000Z',
    kind: 'assortment_boundary' as const,
    mode: 'create' as const,
    permission: 'assortment.boundary.create' as const,
    purpose: 'PURCHASE' as const,
    subject: {
      kind: 'COUNTERPARTY' as const,
      ref: { moduleId: 'party.registry', resourceId: 'counterparty-1', resourceType: 'party.registry.counterparty' },
    },
  };
  const original = toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, target);
  const meanings = [original];
  for (const [kind, resourceId] of [
    ['PRODUCT', 'product-a'],
    ['CATEGORY', 'category-c'],
    ['ALL', 'none'],
    ['PRODUCT', 'product-b'],
  ] as const) {
    const entry =
      kind === 'ALL'
        ? { kind }
        : {
            kind,
            target: {
              moduleId: 'commerce.catalog',
              resourceId,
              resourceType: kind === 'CATEGORY' ? 'commerce.catalog.product-category' : 'commerce.catalog.product',
            },
          };
    meanings.push(
      toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, {
        ...target,
        admissionSet: { contentHash: 'a'.repeat(64), entries: [entry], memberCount: 1, setKind: 'ENTRIES' },
      }),
    );
  }
  expect(original).toBeDefined();
  expect(meanings).not.toContain(undefined);
  expect(new Set(meanings).size).toBe(5);
  expect(
    toAssortmentPermissionAccessObjectId(tenantId, legalEntityId, {
      ...target,
      admissionSet: { contentHash: 'a'.repeat(64), entries: [], memberCount: 1, setKind: 'ENTRIES' },
    }),
  ).toBeUndefined();
  const invalidVisibility = {
    ...target,
    admissionSet: {
      contentHash: 'a'.repeat(64),
      entries: [
        {
          kind: 'VARIANT' as const,
          target: { moduleId: 'commerce.catalog', resourceId: 'variant-1', resourceType: 'commerce.catalog.variant' },
        },
      ],
      memberCount: 1,
      setKind: 'ENTRIES' as const,
    },
    purpose: 'VISIBILITY' as const,
  };
  expect(
    assortmentPermissionTargetIsValid(invalidVisibility, {
      authContextRef: 'test',
      authMethod: 'session',
      correlationId: 'test',
      legalEntityId,
      principalId: 'actor',
      tenantId,
    }),
  ).toBe(false);
  expect(Schema.is(AssortmentPermissionTargetSchema)({ ...target, purpose: 'OTHER' })).toBe(false);
});

it('rejects an unsupported permission, unknown configuration target and incompatible rule selector in the owner contract', () => {
  const scope = {
    authContextRef: 'test',
    authMethod: 'session' as const,
    correlationId: 'test',
    legalEntityId,
    principalId: 'actor',
    tenantId,
  };
  const configuration = {
    kind: 'assortment_configuration' as const,
    permission: 'assortment.configuration.read' as const,
    resource: {
      moduleId: 'commerce.assortment',
      resourceId: 'configuration-1',
      resourceType: 'commerce.assortment.configuration',
    },
  };
  expect(() => assortmentOwnerPermissionTarget(scope, configuration)).toThrow();
  const rule = {
    effect: 'ALLOW' as const,
    kind: 'assortment_rule' as const,
    mode: 'create' as const,
    permission: 'assortment.rule.create' as const,
    purpose: 'VISIBILITY' as const,
    selector: {
      kind: 'VARIANT' as const,
      target: { moduleId: 'commerce.catalog', resourceId: 'variant-1', resourceType: 'commerce.catalog.variant' },
    },
    stableCode: 'rule-1',
  };
  expect(() => assortmentOwnerPermissionTarget(scope, rule)).toThrow();
  for (const permission of ['assortment.manage', 'assortment.boundary.replace', 'assortment.rules.create']) {
    expect(Schema.is(AssortmentPermissionTargetSchema)({ ...rule, permission })).toBe(false);
  }
});
