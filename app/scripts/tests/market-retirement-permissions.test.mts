import { readFileSync } from 'node:fs';

import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import {
  MarketRetirementReservationOperationSchema,
  ReserveMarketRetirementApi,
  ReserveMarketRetirementPayloadSchema,
} from '../../packages/customer-market-retirement-contracts/src/apis/reserve-market-retirement.ts';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  toSpiceDbActionGrantObjectId,
  toSpiceDbActionObjectId,
} from '../../packages/core-runtime/src/permissions/service.ts';
import {
  akrosDemoLegalEntityId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
} from '../demo/fixture-ids.mts';
import {
  demoPermissionRelationships,
  demoPrincipalRoleKey,
  marketRetirementActionKeys,
  marketRetirementPrincipal,
  marketRetirementRelationships,
} from '../demo/permissions.mts';
import type { DemoAction } from '../demo/permissions.mts';
import { customerContextSourceAction, marketRetirementSourceAction } from './market-retirement-contract.fixture.mts';

const commerceModule = 'commerce.customer-context';
const marketModule = 'commerce.market-catalog';
const reserveKey = marketRetirementSourceAction.actionKey;
const retirementActions = [marketRetirementSourceAction];
const companyRole = toScopedRoleObjectId({
  legalEntityId: akrosDemoLegalEntityId,
  roleKey: demoPrincipalRoleKey(marketRetirementPrincipal.principalId),
  tenantId: demoTenantId,
});
const actionScope = (actionKey: string) => ({
  actionKey,
  legalEntityId: akrosDemoLegalEntityId,
  tenantId: demoTenantId,
});
const unrelatedActions = [
  customerContextSourceAction('reserve-payment-term-retirement'),
  customerContextSourceAction('ensure-retail-customer-profile'),
];
const descriptors = [...retirementActions, ...unrelatedActions];

it('pins the dedicated Market service identity and exact retirement Action allowlist', () => {
  expect(marketRetirementPrincipal).toEqual({
    apiKeyName: 'market-retirement-authority',
    displayName: 'Market · retirement authority',
    legalEntityId: akrosDemoLegalEntityId,
    principalId: 'e9ebc093-a7be-5a1a-a5f7-06cf9961fa8f',
  });
  expect(marketRetirementSourceAction).toEqual({
    actionKey: 'commerce.customer-context.reserve-market-retirement',
    legalEntityScope: 'required',
    owningModuleKey: commerceModule,
    provisioning: 'explicit',
  });
  expect(marketRetirementActionKeys).toEqual([reserveKey]);
});

it('uses one published reserve Action contract for RESERVE, COMMIT and RELEASE', () => {
  expect(ReserveMarketRetirementApi.groups.reserveMarketRetirement.endpoints.execute.path).toBe(
    '/commerce-customer-context/actions/reserve-market-retirement',
  );
  const identity = {
    marketRef: {
      moduleId: marketModule,
      resourceId: 'market-a',
      resourceType: 'commerce.market-catalog.market',
      tenantId: demoTenantId,
    },
    marketRevision: 1,
    reason: 'Retire this Market',
    tenantId: demoTenantId,
  };
  for (const operation of ['RESERVE', 'COMMIT', 'RELEASE']) {
    expect(Schema.is(MarketRetirementReservationOperationSchema)(operation)).toBe(true);
  }
  for (const operation of ['COMMIT', 'RELEASE'] as const) {
    expect(
      Schema.is(ReserveMarketRetirementPayloadSchema)({
        ...identity,
        operation,
        reservationToken: '74000000-0000-4000-8000-000000000010',
        reservationVersion: 1,
      }),
    ).toBe(true);
  }
  const manifestSource = readFileSync(
    new URL('../../verticals/commerce-customer-context/vertical.manifest.ts', import.meta.url),
    'utf-8',
  );
  expect(manifestSource).toContain("from './src/actions/reserve-market-retirement.action.ts'");
  expect(manifestSource).toContain('      reserveMarketRetirementAction,');
  expect(manifestSource).not.toContain('finish-market-retirement');
});

it('keeps both CCC reads on the same Market permission and the native Market resource read gate', () => {
  for (const slug of ['market-affected-use-assessment', 'market-retirement-reservation']) {
    const source = readFileSync(
      new URL(`../../verticals/commerce-customer-context/src/api/${slug}.read.ts`, import.meta.url),
      'utf-8',
    );
    expect(source).toContain("authorization: { kind: 'context_permission', permission: 'market.catalog.read' }");
    expect(source).toContain("permission: 'read',\n      resource: marketRef,");
    expect(source).toContain("legalEntityScope: 'required'");
  }
});

it('grants only the scoped Market read permission and the real reserve Action through one company role', () => {
  const rows = marketRetirementRelationships(descriptors);
  const capabilities = rows.filter((row) => row.subjectType === 'scoped_role');
  expect(capabilities.every((row) => row.subjectId === companyRole && row.subjectRelation === 'member')).toBe(true);
  expect(
    capabilities.map(({ relation, resourceId, resourceType }) => ({ relation, resourceId, resourceType })),
  ).toEqual([
    ...['core.shell', commerceModule].map((moduleId) => ({
      relation: 'accessor_role',
      resourceId: toModuleAccessObjectId(demoTenantId, akrosDemoLegalEntityId, moduleId),
      resourceType: 'module_access',
    })),
    {
      relation: 'role_grantee',
      resourceId: toContextPermissionAccessObjectId(demoTenantId, akrosDemoLegalEntityId, {
        moduleId: commerceModule,
        permission: 'market.catalog.read',
      }),
      resourceType: 'context_permission',
    },
    {
      relation: 'role',
      resourceId: toSpiceDbActionGrantObjectId(actionScope(reserveKey)),
      resourceType: 'action_grant',
    },
    {
      relation: 'reader_role',
      resourceId: toModuleAccessObjectId(demoTenantId, akrosDemoLegalEntityId, marketModule),
      resourceType: 'module_access',
    },
    // The same gateway validates Storefront Application currentness before an association.
    {
      relation: 'reader_role',
      resourceId: toModuleAccessObjectId(demoTenantId, akrosDemoLegalEntityId, 'commerce.storefront-registry'),
      resourceType: 'module_access',
    },
  ]);
  expect(rows.filter((row) => row.resourceType === 'scoped_role')).toEqual([
    {
      relation: 'member',
      resourceId: companyRole,
      resourceType: 'scoped_role',
      subjectId: marketRetirementPrincipal.principalId,
      subjectType: 'principal',
    },
  ]);
  expect(
    rows
      .filter((row) => row.resourceType === 'action')
      .map((row) => row.resourceId)
      .filter((id, index, ids) => ids.indexOf(id) === index),
  ).toEqual([toSpiceDbActionObjectId(actionScope(reserveKey))]);
  expect(rows.filter((row) => row.resourceType === 'legal_entity' && row.relation === 'member')).toEqual([
    {
      relation: 'member',
      resourceId: toLegalEntityAccessObjectId(demoTenantId, akrosDemoLegalEntityId),
      resourceType: 'legal_entity',
      subjectId: marketRetirementPrincipal.principalId,
      subjectType: 'principal',
    },
  ]);
  expect(
    rows.some((row) =>
      ['admin', 'superadmin', 'identity_admin', 'executor', 'context_role', 'writer_role', 'writer'].includes(
        row.relation,
      ),
    ),
  ).toBe(false);
});

it('does not grant tenant-wide or other-company retirement authority', () => {
  const rows = marketRetirementRelationships(descriptors);
  for (const legalEntityId of [demoLegalEntityId, eshopDemoLegalEntityId]) {
    expect(
      rows.some((row) => row.resourceId === toModuleAccessObjectId(demoTenantId, legalEntityId, marketModule)),
    ).toBe(false);
  }
  for (const actionKey of [reserveKey]) {
    for (const legalEntityId of [undefined, demoLegalEntityId, eshopDemoLegalEntityId]) {
      const scope = { actionKey, legalEntityId, tenantId: demoTenantId };
      expect(rows.some((row) => row.resourceId === toSpiceDbActionGrantObjectId(scope))).toBe(false);
      expect(rows.some((row) => row.resourceId === toSpiceDbActionObjectId(scope))).toBe(false);
    }
    const foreignTenantScope = {
      actionKey,
      legalEntityId: akrosDemoLegalEntityId,
      tenantId: '70000000-0000-4000-8000-000000000099',
    };
    expect(rows.some((row) => row.resourceId === toSpiceDbActionGrantObjectId(foreignTenantScope))).toBe(false);
  }
});

for (const invalid of [
  { legalEntityScope: 'forbidden' },
  { legalEntityScope: 'optional' },
  { owningModuleKey: 'party.registry' },
  { provisioning: 'tenant_membership_default' },
] satisfies readonly Partial<DemoAction>[]) {
  it(`does not grant a retirement descriptor with unexpected metadata ${JSON.stringify(invalid)}`, () => {
    const rows = marketRetirementRelationships(retirementActions.map((descriptor) => ({ ...descriptor, ...invalid })));
    expect(rows.some((row) => row.resourceType === 'action' || row.resourceType === 'action_grant')).toBe(false);
  });
}

it('never invents a missing retirement Action or falls back to unrelated Actions', () => {
  const rows = marketRetirementRelationships(descriptors);
  expect(rows.filter((row) => row.resourceType === 'action_grant' && row.relation === 'role')).toHaveLength(1);
  expect(marketRetirementRelationships(unrelatedActions).some((row) => row.resourceType === 'action_grant')).toBe(
    false,
  );
});

it('keeps fresh-bootstrap service policy aligned without treating a role grant as Action installation evidence', () => {
  const rows = demoPermissionRelationships(descriptors, {
    companies: [{ legalEntityId: akrosDemoLegalEntityId, status: 'active', tenantId: demoTenantId }],
    moduleStates: [{ moduleKey: commerceModule, state: 'active', tenantId: demoTenantId }],
    publishedModuleKeys: [commerceModule],
  });
  for (const relationship of marketRetirementRelationships(descriptors).filter(
    (row) => row.resourceType !== 'action',
  )) {
    expect(rows).toContainEqual(relationship);
  }
  expect(
    rows.some((row) => row.subjectId === marketRetirementPrincipal.principalId && row.relation === 'company_member'),
  ).toBe(false);
  const uninstalled = demoPermissionRelationships(descriptors, {
    companies: [],
    moduleStates: [],
    publishedModuleKeys: [],
  });
  expect(
    uninstalled.some(
      (row) => row.resourceType === 'action' && row.resourceId === toSpiceDbActionObjectId(actionScope(reserveKey)),
    ),
  ).toBe(false);
});
