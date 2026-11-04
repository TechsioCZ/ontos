import { v1 } from '@authzed/authzed-node';
import { Array as EffectArray, ConfigProvider, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { SpiceDbRpcError } from '../../packages/core-runtime/src/permissions/spicedb-rpc.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import {
  SearchStagePolicyError,
  assertReviewedSearchStagePlan,
  decodeSearchStagePlan,
  planSearchStagePolicy,
  runSearchStagePolicy,
  searchRebuildActions,
  searchStageEnvironment,
  searchStageFailureMessage,
  searchStagePlanDigest,
  searchStageSource,
} from '../demo/search-stage-policy.mts';
import type { SearchStageRpc } from '../demo/search-stage-policy.mts';
import { akrosDemoLegalEntityId, crmDemoLegalEntityId, demoTenantId } from '../demo/fixture-ids.mts';
import { companyHumanAccounts, demoHumanAccounts } from '../demo/permissions.mts';
import type { DemoAction } from '../demo/permissions.mts';

const core: DemoAction = {
  actionKey: 'core.identity.request-people-search-rebuild',
  legalEntityScope: 'forbidden',
  owningModuleKey: 'core.identity',
  provisioning: 'explicit',
};
const portfolioModule = 'property.portfolio';
const leasingModule = 'property.leasing';
const moduleAction = (owningModuleKey: string): DemoAction => ({
  actionKey: `${owningModuleKey}.request-search-rebuild`,
  legalEntityScope: owningModuleKey === portfolioModule || owningModuleKey === leasingModule ? 'required' : 'optional',
  owningModuleKey,
  provisioning: 'explicit',
});
const catalog = [
  core,
  moduleAction('demo.merchandise'),
  moduleAction('demo.crm'),
  moduleAction('commerce.market-catalog'),
  moduleAction('finance.billing'),
  moduleAction('legal.agreements'),
  moduleAction(portfolioModule),
  moduleAction(leasingModule),
  moduleAction('facility.operations'),
  moduleAction('demo.sales-pipeline'),
  moduleAction('work.tasks'),
  moduleAction('demo.workforce'),
  moduleAction('projects.core'),
];
const party: DemoAction = {
  actionKey: 'party.registry.request-search-rebuild',
  legalEntityScope: 'optional',
  owningModuleKey: 'party.registry',
  provisioning: 'tenant_membership_default',
};
const revision = 'a'.repeat(64);
const key = (relationship: v1.Relationship) => v1.Relationship.toJsonString(relationship);
const parse = (items: readonly string[]) => items.map((item) => v1.Relationship.fromJsonString(item));
const hasRolePermission = (rows: readonly v1.Relationship[], request: v1.CheckPermissionRequest) => {
  const grants = new Set(
    rows
      .filter((item) => item.resource?.objectId === request.resource?.objectId && item.relation === 'grant')
      .map((item) => item.subject?.object?.objectId),
  );
  const roles = new Set(
    rows
      .filter((item) => item.relation === 'role' && grants.has(item.resource?.objectId))
      .map((item) => item.subject?.object?.objectId),
  );
  const scopes = rows.filter(
    (item) =>
      item.resource?.objectId === request.resource?.objectId &&
      (item.relation === 'company_scope' || item.relation === 'tenant_scope'),
  );
  const administration = rows.filter(
    (item) =>
      (item.resource?.objectType === 'tenant' &&
        item.resource.objectId === demoTenantId &&
        item.relation === 'superadmin' &&
        scopes.length > 0) ||
      (item.relation === 'admin' &&
        scopes.some(
          (scope) =>
            scope.subject?.object?.objectType === item.resource?.objectType &&
            scope.subject?.object?.objectId === item.resource?.objectId,
        )),
  );
  for (const item of administration) {
    roles.add(item.subject?.object?.objectId);
  }
  return rows.some(
    (item) =>
      item.relation === 'member' &&
      item.resource?.objectType === 'scoped_role' &&
      item.subject?.object?.objectId === request.subject?.object?.objectId &&
      roles.has(item.resource?.objectId),
  );
};
const matches = (item: v1.Relationship, request: v1.ReadRelationshipsRequest) => {
  const filter = request.relationshipFilter;
  const subject = filter?.optionalSubjectFilter;
  const object = item.subject?.object;
  const { resource } = item;
  if (filter === undefined || subject === undefined || object === undefined || resource === undefined) {
    return false;
  }
  return (
    resource.objectType === filter.resourceType &&
    resource.objectId === filter.optionalResourceId &&
    item.relation === filter.optionalRelation &&
    object.objectType === subject.subjectType &&
    object.objectId === subject.optionalSubjectId &&
    item.subject?.optionalRelation === subject?.optionalRelation?.relation
  );
};

/** A native RPC seam, not a module mock. Exact filters, conditional evidence and all writes are observable. */
const memory = (initial: readonly string[]) => {
  const stored = new Map(parse(initial).map((relationship) => [key(relationship), relationship]));
  const reads: v1.ReadRelationshipsRequest[] = [];
  const writes: v1.WriteRelationshipsRequest[] = [];
  let schemaDiff = false;
  let indeterminate = false;
  let permissionDrift = false;
  const rpc: SearchStageRpc = {
    checkPermission: (request) =>
      Effect.sync(() => {
        if (indeterminate) {
          return v1.CheckPermissionResponse.create({
            permissionship: v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION,
          });
        }
        const allowed = permissionDrift || hasRolePermission([...stored.values()], request);
        return v1.CheckPermissionResponse.create({
          permissionship: allowed
            ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
            : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        });
      }),
    diffSchema: () =>
      Effect.succeed(
        v1.DiffSchemaResponse.create({
          diffs: schemaDiff
            ? [
                v1.ReflectionSchemaDiff.create({
                  diff: {
                    definitionAdded: v1.ReflectionDefinition.create({ name: 'resource' }),
                    oneofKind: 'definitionAdded',
                  },
                }),
              ]
            : [],
        }),
      ),
    readRelationships: (request) =>
      Effect.sync(() => {
        reads.push(request);
        return [...stored.values()]
          .filter((item) => matches(item, request))
          .map((relationship) => v1.ReadRelationshipsResponse.create({ relationship }));
      }),
    readSchema: () =>
      Effect.succeed(v1.ReadSchemaResponse.create({ readAt: { token: 'revision' }, schemaText: ONTOS_SPICEDB_SCHEMA })),
    writeRelationships: (request) =>
      Effect.sync(() => {
        writes.push(request);
        for (const update of request.updates) {
          expect(update.operation).toBe(v1.RelationshipUpdate_Operation.CREATE);
          if (update.relationship !== undefined) {
            expect(stored.has(key(update.relationship))).toBe(false);
            stored.set(key(update.relationship), update.relationship);
          }
        }
        return v1.WriteRelationshipsResponse.create({});
      }),
  };
  return {
    drift: () => {
      permissionDrift = true;
    },
    reads,
    rpc,
    schemaGap: () => {
      schemaDiff = true;
    },
    stored,
    unknownDecision: () => {
      indeterminate = true;
    },
    writes,
  };
};

it.effect('derives only executor grants from current role policy, including the source tenant administrator role', () =>
  Effect.gen(function* sourceAuthority() {
    const source = yield* searchStageSource(catalog);
    const desired = parse(source.desired);
    expect(desired.length).toBeGreaterThan(0);
    expect(
      desired.every(
        (item) =>
          (item.resource?.objectType === 'action' &&
            ['company_scope', 'tenant_scope', 'grant'].includes(item.relation)) ||
          (item.resource?.objectType === 'action_grant' &&
            item.relation === 'role' &&
            item.subject?.object?.objectType === 'scoped_role' &&
            item.subject.optionalRelation === 'member'),
      ),
    ).toBe(true);
    expect(
      parse(source.prerequisites).some(
        (item) => item.resource?.objectType === 'tenant' && item.relation === 'superadmin',
      ),
    ).toBe(true);
    const plan = yield* planSearchStagePolicy(memory(source.prerequisites).rpc, source, revision);
    const admin = demoHumanAccounts.find((account) => account.role === 'headOfSales');
    expect(
      plan.checks.some(
        (check) =>
          check.principalId === admin?.principalId &&
          check.expected &&
          check.objectId === toSpiceDbActionObjectId({ actionKey: core.actionKey, tenantId: demoTenantId }),
      ),
    ).toBe(true);
    const rep = companyHumanAccounts.find((account) => account.role === 'crmRep');
    expect(
      plan.checks.find(
        (check) =>
          check.principalId === rep?.principalId &&
          check.objectId ===
            toSpiceDbActionObjectId({
              actionKey: 'demo.crm.request-search-rebuild',
              legalEntityId: crmDemoLegalEntityId,
              tenantId: demoTenantId,
            }),
      )?.expected,
    ).toBe(true);
    expect(
      plan.checks.find(
        (check) =>
          check.principalId === rep?.principalId &&
          check.objectId ===
            toSpiceDbActionObjectId({
              actionKey: 'demo.crm.request-search-rebuild',
              legalEntityId: akrosDemoLegalEntityId,
              tenantId: demoTenantId,
            }),
      )?.expected,
    ).toBe(false);
    expect(
      plan.checks.find(
        (check) =>
          check.principalId === rep?.principalId &&
          check.objectId === toSpiceDbActionObjectId({ actionKey: core.actionKey, tenantId: demoTenantId }),
      )?.expected,
    ).toBe(false);
    expect(plan.checks.some((check) => !check.expected)).toBe(true);
  }),
);

it.effect('rejects missing, duplicate, foreign-owner, unknown and mis-scoped rebuild catalogs', () =>
  Effect.gen(function* rejectedCatalogs() {
    const cases = [
      [],
      [core, core],
      [core, moduleAction('unreviewed.owner')],
      [core, { ...moduleAction('demo.crm'), actionKey: 'demo.merchandise.request-search-rebuild' }],
      [{ ...core, legalEntityScope: 'required' as const }],
      [core, { ...moduleAction('demo.crm'), legalEntityScope: 'required' as const }],
      [core, { ...moduleAction(portfolioModule), legalEntityScope: 'optional' as const }],
      [core, { ...moduleAction(leasingModule), legalEntityScope: 'optional' as const }],
      [core, { ...moduleAction('demo.crm'), provisioning: 'tenant_membership_default' as const }],
      [core, { ...moduleAction('demo.workforce'), legalEntityScope: 'required' as const }],
      [core, { ...moduleAction('projects.core'), provisioning: 'tenant_membership_default' as const }],
      [core, { ...party, provisioning: 'explicit' as const }],
      [core, { ...party, legalEntityScope: 'required' as const }],
      [core, party, party],
      [core, { ...core, actionKey: 'other.identity.request-people-search-rebuild' }],
    ];
    for (const actions of cases) {
      expect(Schema.is(SearchStagePolicyError)(yield* searchRebuildActions(actions).pipe(Effect.flip))).toBe(true);
    }
    const selected = yield* searchRebuildActions([
      ...catalog,
      {
        ...moduleAction('demo.crm'),
        actionKey: 'demo.crm.apply-command',
      },
    ]);
    expect(selected).toHaveLength(catalog.length);
    expect(yield* searchStageSource(EffectArray.reverse(catalog))).toEqual(yield* searchStageSource(catalog));
  }),
);

it.effect('supports a module-only deployment and leaves the existing Party rebuild policy untouched', () =>
  Effect.gen(function* incrementalCatalog() {
    const modules = catalog.filter(({ actionKey }) => actionKey !== core.actionKey);
    expect(yield* searchRebuildActions([...modules, party])).toEqual(yield* searchRebuildActions(modules));
    expect(yield* searchStageSource([...modules, party])).toEqual(yield* searchStageSource(modules));
    const source = yield* searchStageSource([...modules, party]);
    expect(source.actions).toHaveLength(modules.length);
    expect(
      source.actions.every((action) => !action.includes(core.actionKey) && !action.includes(party.actionKey)),
    ).toBe(true);
    const state = memory(source.prerequisites);
    const plan = yield* planSearchStagePolicy(state.rpc, source, revision);
    expect(plan.checks.length).toBeGreaterThan(0);
    expect(state.writes).toHaveLength(0);
    expect(yield* searchStageSource([...catalog, party])).toEqual(yield* searchStageSource(catalog));
  }),
);

it.effect('planning and verification are read-only; apply is additive, exact, and idempotent', () =>
  Effect.gen(function* additiveApply() {
    const source = yield* searchStageSource(catalog);
    const unrelated = v1.Relationship.create({
      relation: 'reader',
      resource: { objectId: 'unrelated', objectType: 'resource' },
      subject: { object: { objectId: 'preserved', objectType: 'principal' } },
    });
    const state = memory([...source.prerequisites, key(unrelated)]);
    const plan = yield* planSearchStagePolicy(state.rpc, source, revision);
    const digest = Option.some(yield* searchStagePlanDigest(plan));
    expect(state.writes).toHaveLength(0);
    expect(
      Schema.is(SearchStagePolicyError)(
        yield* runSearchStagePolicy(state.rpc, 'verify', plan, source, revision, digest).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(state.writes).toHaveLength(0);
    expect((yield* runSearchStagePolicy(state.rpc, 'apply', plan, source, revision, digest)).applied).toBe(
      plan.missing.length,
    );
    expect(state.writes).toHaveLength(1);
    expect(
      state.writes[0]?.updates.map(({ relationship }) => (relationship === undefined ? '' : key(relationship))),
    ).toEqual(plan.missing);
    expect(
      state.writes[0]?.optionalPreconditions.filter((item) => item.operation === v1.Precondition_Operation.MUST_MATCH),
    ).toHaveLength(source.prerequisites.length);
    expect((yield* runSearchStagePolicy(state.rpc, 'apply', plan, source, revision, digest)).applied).toBe(0);
    yield* runSearchStagePolicy(state.rpc, 'verify', plan, source, revision, digest);
    expect(state.writes).toHaveLength(1);
    expect(state.stored.has(key(unrelated))).toBe(true);
    expect(
      state.reads.every(
        ({ relationshipFilter: filter }) =>
          filter?.optionalResourceId !== '' && filter?.optionalSubjectFilter?.optionalSubjectId !== '',
      ),
    ).toBe(true);
  }),
);

it.effect('binds the complete reviewed plan, missing set, assertions, source and composition to its digest', () =>
  Effect.gen(function* immutableReview() {
    const source = yield* searchStageSource(catalog);
    const state = memory(source.prerequisites);
    const plan = yield* planSearchStagePolicy(state.rpc, source, revision);
    const digest = Option.some(yield* searchStagePlanDigest(plan));
    for (const altered of [
      { ...plan, missing: plan.missing.slice(1) },
      { ...plan, checks: plan.checks.map((check) => ({ ...check, expected: !check.expected })) },
      { ...plan, liveSchemaSha256: 'modified' },
    ]) {
      expect(
        Schema.is(SearchStagePolicyError)(
          yield* runSearchStagePolicy(state.rpc, 'apply', altered, source, revision, digest).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
    for (const reviewed of [Option.none(), Option.some('wrong')]) {
      expect(
        Schema.is(SearchStagePolicyError)(
          yield* runSearchStagePolicy(state.rpc, 'apply', plan, source, revision, reviewed).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
    yield* assertReviewedSearchStagePlan(plan, source, 'b'.repeat(64), digest).pipe(Effect.flip);
    yield* assertReviewedSearchStagePlan(plan, { ...source, desired: source.desired.slice(1) }, revision, digest).pipe(
      Effect.flip,
    );
    const untrustedJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
    yield* decodeSearchStagePlan(yield* untrustedJson({ ...plan, origin: 'https://production.example' })).pipe(
      Effect.flip,
    );
    yield* decodeSearchStagePlan(yield* untrustedJson({ ...plan, unexpected: 'field' })).pipe(Effect.flip);
    expect(state.writes).toHaveLength(0);
  }),
);

it.effect(
  'refuses schema, membership, caveat, indeterminate checks, drift and newly missing grants without writes',
  () =>
    Effect.gen(function* prerequisiteFailures() {
      const source = yield* searchStageSource(catalog);
      for (const kind of ['schema', 'membership', 'conditional', 'indeterminate', 'drift', 'new-missing']) {
        const state = memory(source.prerequisites);
        const plan = yield* planSearchStagePolicy(state.rpc, source, revision);
        const reviewed = kind === 'new-missing' ? { ...plan, missing: plan.missing.slice(1) } : plan;
        const digest = Option.some(yield* searchStagePlanDigest(reviewed));
        if (kind === 'schema') {
          state.schemaGap();
        }
        if (kind === 'membership') {
          state.stored.delete(source.prerequisites[0] ?? '');
        }
        if (kind === 'conditional') {
          const [grant] = parse(source.desired);
          if (grant !== undefined) {
            const conditional = v1.Relationship.create({ ...grant, optionalExpiresAt: { nanos: 0, seconds: '100' } });
            state.stored.set(key(conditional), conditional);
          }
        }
        if (kind === 'indeterminate') {
          state.unknownDecision();
        }
        if (kind === 'drift') {
          state.drift();
        }
        expect(
          Schema.is(SearchStagePolicyError)(
            yield* runSearchStagePolicy(state.rpc, 'apply', reviewed, source, revision, digest).pipe(Effect.flip),
          ),
        ).toBe(true);
        expect(state.writes).toHaveLength(0);
      }
      const state = memory([]);
      state.schemaGap();
      const blocked = yield* planSearchStagePolicy(state.rpc, source, revision);
      expect(blocked.missingPrerequisites.length).toBeGreaterThan(0);
      expect(blocked.schemaDiffKinds.length).toBeGreaterThan(0);
      expect(state.writes).toHaveLength(0);
      const unknownContext = memory(source.prerequisites);
      unknownContext.drift();
      yield* planSearchStagePolicy(unknownContext.rpc, source, revision).pipe(Effect.flip);
      expect(unknownContext.writes).toHaveLength(0);
    }),
);

it('sanitizes provider failures without exposing their causes or credentials', () => {
  const error = new SpiceDbRpcError({ cause: { endpoint: 'private', secret: 'do-not-print' }, code: Option.none() });
  expect(searchStageFailureMessage(error)).not.toContain('do-not-print');
  expect(searchStageFailureMessage(error)).not.toContain('private');
  expect(searchStageFailureMessage(new SearchStagePolicyError({ reason: 'Authorship requires review' }))).toBe(
    'Authorship requires review',
  );
});

it.effect('accepts only the fixed Zerops stage origin, environment and private endpoint', () =>
  Effect.gen(function* fixedTarget() {
    const environment = {
      ONTOS_PUBLIC_ORIGIN: 'https://ontos-stage.web-revolution.cz',
      SPICEDB_CA_CERT: 'fixture-ca',
      SPICEDB_ENDPOINT: 'spicedb:50051',
      SPICEDB_PRESHARED_KEY: 'fixture-secret',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    };
    yield* searchStageEnvironment.parse(ConfigProvider.fromUnknown(environment));
    for (const changed of [
      { ...environment, ONTOS_PUBLIC_ORIGIN: 'https://production.example' },
      { ...environment, SPICEDB_ENDPOINT: 'localhost:50051' },
      { ...environment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
      { ...environment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'unknown' },
    ]) {
      yield* searchStageEnvironment.parse(ConfigProvider.fromUnknown(changed)).pipe(Effect.flip);
    }
  }),
);
