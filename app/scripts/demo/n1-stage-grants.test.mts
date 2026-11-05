import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { v1 } from '@authzed/authzed-node';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  createN1GrantPlan,
  decodeN1Access,
  decodeN1Contracts,
  executeN1ReviewedPlan,
  N1_LEGAL_ENTITY_ID,
  N1_STAGE_ORIGIN,
  N1_TENANT_ID,
  N1StageGrantError,
  n1ManifestSources,
  n1PlanFingerprint,
  n1ServiceDefinitions,
  revokeRetiredN1Relationships,
  verifyN1Checks,
} from './n1-stage-grants.mts';
import type { N1ContractDocument, N1GrantPlan, N1PermissionCheck } from './n1-stage-grants.mts';
import { akrosPlaygroundTenantId } from './akros-playground-policy.mts';
import { demoTenantId } from './fixture-ids.mts';
import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';

const principal = (suffix: string) => `8a000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const ignoredCredential = ['private', 'test', 'sentinel'].join('-');
const bindManagedKey = 'core.identity.bind-managed-api-key';
const merchandiseModule = 'demo.merchandise';
const workTasksModule = 'work.tasks';
const allAssertions = 'assert-all';
const deniedAssertions = 'assert-denied';
const access = () => ({
  accounts: [
    {
      displayName: 'N1 admin',
      email: 'admin@n1.ontos.demo',
      password: ignoredCredential,
      principalId: principal('1'),
    },
    {
      displayName: 'N1 catalog',
      email: 'catalog@n1.ontos.demo',
      password: ignoredCredential,
      principalId: principal('2'),
    },
  ],
  legalEntityId: N1_LEGAL_ENTITY_ID,
  modules: {
    'commerce.market-catalog': principal('10'),
    'commerce.storefront-registry': principal('11'),
    [merchandiseModule]: principal('12'),
  },
  schemaVersion: 1,
  services: { 'market-authority': principal('4'), storefront: principal('3') },
  shellUrl: N1_STAGE_ORIGIN,
  slug: 'n1-demo-20261103',
  tenantId: N1_TENANT_ID,
});

// Public wire fixtures, never another deployment's private registration or a fabricated composition.
const contract = (appId: string, moduleId: string, actionKey = `${moduleId}.apply-command`) => ({
  deployment: { appId, buildMarker: 'test-release-marker' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active'],
    },
    module: {
      description: 'Public test contract',
      displayName: appId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [
        {
          actionKey,
          auditProfile: 'standard',
          entrypoint: {
            access: 'write',
            authorization: { kind: 'action_execution', provisioning: 'explicit' },
            entrypointKey: actionKey,
            moduleKey: moduleId,
            role: 'action',
            scope: 'tenant',
          },
          idempotency: 'required',
          legalEntityScope: 'required',
          owningModuleId: moduleId,
          schemaVersion: '1',
        },
      ],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});
const documents = (): readonly N1ContractDocument[] =>
  n1ManifestSources.map(({ appId, moduleId }) => ({ appId, source: JSON.stringify(contract(appId, moduleId)) }));
const parseAccess = (input: ReturnType<typeof access>) => decodeN1Access(JSON.stringify(input));
const buildPlan = (input: ReturnType<typeof access>, contracts: readonly N1ContractDocument[]) =>
  parseAccess(input).pipe(Effect.flatMap((decoded) => createN1GrantPlan(decoded, contracts)));
const planFixture = () => buildPlan(access(), documents());
const fails = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
  );

it.effect('projects credentials away and rejects another target, duplicate accounts or reused service identities', () =>
  Effect.gen(function* accessGuards() {
    const decoded = yield* parseAccess(access());
    expect(JSON.stringify(decoded)).not.toContain(ignoredCredential);
    expect(JSON.stringify(decoded)).not.toContain('password');
    yield* fails(parseAccess({ ...access(), tenantId: demoTenantId }));
    yield* fails(parseAccess({ ...access(), legalEntityId: principal('100') }));
    yield* fails(parseAccess({ ...access(), shellUrl: 'http://localhost:3020' }));
    yield* fails(
      parseAccess({ ...access(), services: { 'market-authority': principal('4'), storefront: principal('1') } }),
    );
    yield* fails(
      parseAccess({
        ...access(),
        accounts: access().accounts.map((account) => ({ ...account, email: 'admin@n1.ontos.demo' })),
      }),
    );
  }),
);

it.effect('decodes only the four complete public owner contracts and the current Core catalog', () =>
  Effect.gen(function* publicContracts() {
    const decoded = yield* decodeN1Contracts(documents());
    expect(decoded.actions.some(({ actionKey }) => actionKey === bindManagedKey)).toBe(true);
    expect(decoded.actions.some(({ actionKey }) => actionKey === 'demo.merchandise.apply-command')).toBe(true);
    expect(decoded.contracts).toHaveLength(4);
    yield* fails(decodeN1Contracts(documents().slice(1)));
    yield* fails(decodeN1Contracts([...documents(), ...documents()]));
    yield* fails(
      decodeN1Contracts(
        documents().map((document) =>
          document.appId === 'merchandise'
            ? { ...document, source: JSON.stringify(contract('merchandise', 'demo.crm')) }
            : document,
        ),
      ),
    );
    yield* fails(
      decodeN1Contracts(
        documents().map((document) =>
          document.appId === 'merchandise'
            ? { ...document, source: document.source.replace('"provisioning":"explicit"', '"provisioning":"unknown"') }
            : document,
        ),
      ),
    );
    yield* fails(
      decodeN1Contracts(
        documents().map((document) =>
          document.appId === 'merchandise'
            ? { ...document, source: document.source.replace('"scope":"tenant"', '"scope":"system"') }
            : document,
        ),
      ),
    );
  }),
);

it.effect(
  'every desired resource and non-principal subject belongs only to N1, with no membership or Workforce writes',
  () =>
    Effect.gen(function* boundedPolicy() {
      const plan = yield* planFixture();
      for (const row of plan.relationships) {
        for (const object of [row.resource, row.subject?.object]) {
          expect(object).toBeDefined();
          if (object === undefined || object.objectType === 'principal') {
            continue;
          }
          if (object.objectType === 'tenant') {
            expect(object.objectId).toBe(N1_TENANT_ID);
          } else {
            const [, encoded] = object.objectId.split('_', 2);
            const scope: unknown = JSON.parse(Buffer.from(encoded ?? '', 'base64url').toString('utf-8'));
            expect(Array.isArray(scope)).toBe(true);
            if (Array.isArray(scope)) {
              expect(scope[0]).toBe(N1_TENANT_ID);
              expect([null, N1_LEGAL_ENTITY_ID, 'legal_entity']).toContain(scope[1]);
              if (scope[1] === 'legal_entity') {
                expect(scope[2]).toBe(N1_LEGAL_ENTITY_ID);
              }
              expect(JSON.stringify(scope)).not.toContain('demo.workforce');
            }
          }
        }
        expect(row.resource?.objectType === 'tenant' && ['member', 'company_member'].includes(row.relation)).toBe(
          false,
        );
        expect(row.resource?.objectType === 'legal_entity' && row.relation === 'member').toBe(false);
      }
      expect(new Set(plan.relationships.map((row) => v1.Relationship.toJsonString(row))).size).toBe(
        plan.relationships.length,
      );
      expect(plan.text).not.toContain('password');
      expect(plan.text).not.toContain(ignoredCredential);
      expect(plan.text).not.toContain('compositionRevision');
      expect(n1ServiceDefinitions(plan.access).map(({ principalId }) => principalId)).toEqual([
        principal('3'),
        principal('4'),
      ]);
    }),
);

it.effect('the administrator has company administration and Core reach; the catalogue manager has neither', () =>
  Effect.gen(function* humanGrants() {
    const plan = yield* planFixture();
    const grants = plan.relationships;
    const administrator = principal('1');
    const catalogue = principal('2');
    const membership = (principalId: string, roleId: string) =>
      grants.some(
        (row) =>
          row.resource?.objectType === 'scoped_role' &&
          row.resource.objectId === roleId &&
          row.relation === 'member' &&
          row.subject?.object?.objectId === principalId,
      );
    const companyAdmin = toScopedRoleObjectId({
      legalEntityId: N1_LEGAL_ENTITY_ID,
      roleKey: 'admin',
      tenantId: N1_TENANT_ID,
    });
    const tenantSuperadmin = toScopedRoleObjectId({ roleKey: 'superadmin', tenantId: N1_TENANT_ID });
    expect(membership(administrator, companyAdmin)).toBe(true);
    expect(membership(administrator, tenantSuperadmin)).toBe(false);
    expect(membership(catalogue, companyAdmin)).toBe(false);
    expect(membership(catalogue, tenantSuperadmin)).toBe(false);
    expect(grants.some((row) => row.resource?.objectType === 'tenant' && row.relation === 'superadmin')).toBe(false);
    // Core modules (people administration, roles) reach the company only through this edge.
    const legal = toLegalEntityAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID);
    for (const moduleId of new Set(coreActionCatalog.map(({ owningModuleKey }) => owningModuleKey))) {
      expect(
        grants.some(
          (row) =>
            row.resource?.objectType === 'module_access' &&
            row.resource.objectId === toModuleAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, moduleId) &&
            row.relation === 'legal_entity' &&
            row.subject?.object?.objectId === legal,
        ),
      ).toBe(true);
    }
    expect(
      grants.some(
        (row) =>
          row.resource?.objectType === 'module_access' &&
          row.resource.objectId === toModuleAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, 'core.identity') &&
          row.subject?.object?.objectId === catalogue,
      ),
    ).toBe(false);
  }),
);

const serviceRole = (roleKey: string) =>
  toScopedRoleObjectId({ legalEntityId: N1_LEGAL_ENTITY_ID, roleKey, tenantId: N1_TENANT_ID });
const hasModuleGrant = (rows: readonly v1.Relationship[], moduleId: string, relation: string) =>
  rows.some(
    (row) =>
      row.resource?.objectId === toModuleAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, moduleId) &&
      row.relation === relation,
  );

it.effect(
  'storefront gets only Market reads, module access and two apply-command executors; authority gets only Market/registry reads',
  () =>
    Effect.gen(function* serviceGrants() {
      const plan = yield* planFixture();
      const grantsFor = (roleKey: string) =>
        plan.relationships.filter((row) => row.subject?.object?.objectId === serviceRole(roleKey));
      const storefront = grantsFor('n1-storefront');
      const authority = grantsFor('n1-market-authority');
      // The storefront's only context permissions are the two explicit write gates, never module-wide read_all.
      const writeGates = [
        toContextPermissionAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, {
          moduleId: merchandiseModule,
          permission: 'demo.merchandise.write_all',
        }),
        toContextPermissionAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID, {
          moduleId: workTasksModule,
          permission: 'work.tasks.write_all',
        }),
      ];
      for (const row of storefront.filter((item) => item.resource?.objectType === 'context_permission')) {
        expect(writeGates).toContain(row.resource?.objectId);
      }
      expect(new Set(storefront.map((row) => row.resource?.objectId)).has(writeGates[0])).toBe(true);
      expect(new Set(storefront.map((row) => row.resource?.objectId)).has(writeGates[1])).toBe(true);
      for (const row of [...storefront, ...authority]) {
        expect(row.relation).not.toBe('writer_role');
      }
      for (const row of authority) {
        expect(row.resource?.objectType).not.toBe('context_permission');
      }
      // Only the storefront holds Action executors, and the exact two are pinned by the checks below.
      for (const row of authority) {
        expect(row.resource?.objectType).not.toBe('action_grant');
      }
      expect(hasModuleGrant(storefront, merchandiseModule, 'accessor_role')).toBe(true);
      expect(hasModuleGrant(storefront, merchandiseModule, 'reader_role')).toBe(false);
      expect(hasModuleGrant(storefront, 'commerce.market-catalog', 'reader_role')).toBe(true);
      expect(hasModuleGrant(storefront, 'commerce.storefront-registry', 'accessor_role')).toBe(false);
      expect(hasModuleGrant(authority, 'commerce.market-catalog', 'reader_role')).toBe(true);
      expect(hasModuleGrant(authority, 'commerce.storefront-registry', 'reader_role')).toBe(true);
      expect(hasModuleGrant(authority, merchandiseModule, 'accessor_role')).toBe(false);
      expect(hasModuleGrant(storefront, workTasksModule, 'accessor_role')).toBe(true);
      expect(hasModuleGrant(storefront, workTasksModule, 'reader_role')).toBe(false);
      expect(hasModuleGrant(authority, workTasksModule, 'accessor_role')).toBe(false);
      const storefrontId = principal('3');
      const storefrontExecutes = plan.checks
        .filter(({ expected, label }) => expected && label.startsWith(`${storefrontId}: N1 service Action `))
        .map(({ label }) => label.slice(`${storefrontId}: N1 service Action `.length))
        .toSorted();
      expect(storefrontExecutes).toEqual(['demo.merchandise.apply-command', 'work.tasks.apply-command']);
      expect(
        plan.relationships.filter((row) => row.resource?.objectType === 'resource' && row.relation === 'module'),
      ).toHaveLength(2);
      expect(plan.checks.some((check) => !check.expected && check.resource.objectId === akrosPlaygroundTenantId)).toBe(
        true,
      );
      expect(plan.checks.some((check) => !check.expected && check.resource.objectId === demoTenantId)).toBe(true);
      expect(
        plan.checks.some(
          (check) =>
            check.expected && check.principalId === principal('3') && check.label.includes('public catalog accessor'),
        ),
      ).toBe(true);
      const optionalAction = toSpiceDbActionObjectId({
        actionKey: bindManagedKey,
        tenantId: N1_TENANT_ID,
      });
      expect(
        plan.checks.some(
          (check) =>
            !check.expected && check.principalId === principal('3') && check.resource.objectId === optionalAction,
        ),
      ).toBe(true);
    }),
);

const recordingPorts = (plan: N1GrantPlan) => {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      installServices: Effect.sync(() => {
        calls.push('install');
      }),
      reconcile: (mode: 'apply' | 'verify') =>
        Effect.sync(() => {
          calls.push(mode);
        }),
      revoke: () =>
        Effect.sync(() => {
          calls.push('revoke');
        }),
      verify: (checks: readonly N1PermissionCheck[]) =>
        Effect.sync(() => {
          calls.push(checks.length === plan.checks.length ? allAssertions : deniedAssertions);
        }),
    },
  };
};

it.effect(
  'no install/write occurs without an exact reviewed plan, and live contract/identity changes invalidate it',
  () =>
    Effect.gen(function* approval() {
      const plan = yield* planFixture();
      const { calls, ports } = recordingPorts(plan);
      yield* fails(executeN1ReviewedPlan('apply', plan, plan.text, undefined, ports));
      yield* fails(executeN1ReviewedPlan('apply', plan, `${plan.text}\n`, plan.fingerprint, ports));
      yield* fails(executeN1ReviewedPlan('apply', plan, plan.text, '0'.repeat(64), ports));
      expect(calls).toEqual([]);
      const changedContracts = yield* buildPlan(
        access(),
        documents().map((document) => ({ ...document, source: `${document.source}\n` })),
      );
      yield* fails(executeN1ReviewedPlan('apply', changedContracts, plan.text, plan.fingerprint, ports));
      const changedIdentity = yield* buildPlan(
        { ...access(), services: { 'market-authority': principal('4'), storefront: principal('20') } },
        documents(),
      );
      yield* fails(executeN1ReviewedPlan('apply', changedIdentity, plan.text, plan.fingerprint, ports));
      expect(calls).toEqual([]);
      yield* executeN1ReviewedPlan('apply', plan, plan.text, plan.fingerprint, ports);
      expect(calls).toEqual([deniedAssertions, 'install', 'apply', 'revoke', 'verify', allAssertions]);
      expect(n1PlanFingerprint(plan.text)).toBe(plan.fingerprint);
    }),
);

it.effect('revoke deletes only live grants the plan does not desire, never a desired row', () =>
  Effect.gen(function* revokeOnlyStale() {
    const plan = yield* planFixture();
    const [desired] = plan.relationships;
    const stale = v1.Relationship.create({
      relation: 'member',
      resource: { objectId: 'stale-role', objectType: 'scoped_role' },
      subject: { object: { objectId: principal('99'), objectType: 'principal' }, optionalRelation: '' },
    });
    const deleted: string[] = [];
    const rpc = {
      readRelationships: () =>
        Effect.succeed([
          v1.ReadRelationshipsResponse.create({ relationship: desired }),
          v1.ReadRelationshipsResponse.create({ relationship: stale }),
        ]),
      writeRelationships: (request: v1.WriteRelationshipsRequest) =>
        Effect.sync(() => {
          for (const update of request.updates) {
            if (update.operation === v1.RelationshipUpdate_Operation.DELETE && update.relationship) {
              deleted.push(v1.Relationship.toJsonString(update.relationship));
            }
          }
          return v1.WriteRelationshipsResponse.create({});
        }),
    };
    yield* revokeRetiredN1Relationships(rpc, plan);
    expect(deleted).toContain(v1.Relationship.toJsonString(stale));
    expect(deleted).not.toContain(v1.Relationship.toJsonString(desired));
  }),
);

it.effect('verify is read-only and a failed isolation preflight prevents even native service installation', () =>
  Effect.gen(function* verificationOrder() {
    const plan = yield* planFixture();
    const { calls, ports } = recordingPorts(plan);
    yield* executeN1ReviewedPlan('verify', plan, plan.text, plan.fingerprint, ports);
    expect(calls).toEqual([deniedAssertions, 'verify', allAssertions]);
    calls.length = 0;
    yield* fails(
      executeN1ReviewedPlan('apply', plan, plan.text, plan.fingerprint, {
        ...ports,
        verify: () => Effect.fail(new N1StageGrantError({ reason: 'Test isolation failure' })),
      }),
    );
    expect(calls).toEqual([]);
  }),
);

it.effect('permission verification requires fully consistent definite allow/deny, not conditional or unspecified', () =>
  Effect.gen(function* definiteAssertions() {
    const resource = {
      objectId: toLegalEntityAccessObjectId(N1_TENANT_ID, N1_LEGAL_ENTITY_ID) ?? '',
      objectType: 'legal_entity',
    };
    const check = {
      expected: false,
      label: 'test denial',
      permission: 'access',
      principalId: principal('3'),
      resource,
    };
    let requests = 0;
    const rpc = (permissionship: v1.CheckPermissionResponse_Permissionship) => ({
      checkPermission: (request: v1.CheckPermissionRequest) => {
        requests += 1;
        expect(request.consistency?.requirement.oneofKind).toBe('fullyConsistent');
        return Effect.succeed(v1.CheckPermissionResponse.create({ permissionship }));
      },
    });
    yield* verifyN1Checks(rpc(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION), [check]);
    yield* verifyN1Checks(rpc(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION), [
      { ...check, expected: true },
    ]);
    yield* fails(verifyN1Checks(rpc(v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION), [check]));
    yield* fails(verifyN1Checks(rpc(v1.CheckPermissionResponse.create({}).permissionship), [check]));
    expect(requests).toBe(4);
  }),
);
