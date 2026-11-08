import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import type { TestGateAnswer } from '@app/core-runtime/access/enforcement';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as drizzleSql } from 'drizzle-orm';
import { recordReachSql, recordVisible } from '../../src/services/record-reach.ts';
import { ListAccessConditionSchema } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessClause, ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { workforceRegistration } from '../../vertical.registration.ts';
import {
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  decideModuleStateAccess,
} from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Exit, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';
import { EmployeesProviderRequestSchema, EmployeesProviderResponseSchema } from '../../shared/apis/employees-search.ts';
import { WorkforceStateSchema } from '../../shared/apis/records.ts';
import { finishWorkforceRecords, WorkforceSearchEmployeeSchema } from '../../src/services/persistence.service.ts';
import { employeesRead } from '../../src/search/employees.provider.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyId = '20000000-0000-4000-8000-000000000001';
const otherCompanyId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000001';
const employeeId = '50000000-0000-4000-8000-000000000001';
const principal = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:workforce-search',
  authMethod: 'session' as const,
  correlationId: 'workforce-search-test',
  legalEntityId: companyId,
  principalId,
  tenantId,
};
const employee = {
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  department: 'Účetní oddělení',
  email: 'private@example.test',
  fullName: 'Jiří Novotný',
  id: employeeId,
  phone: '+420 777 111 222',
  role: 'ACCOUNTANT' as const,
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const hit = Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
  archived: false,
  facets: [],
  metadata: [{ key: 'private', kind: 'string', value: 'never return stale metadata' }],
  ref: { moduleId: 'demo.workforce', resourceId: employeeId, resourceType: 'demo.workforce.employee', tenantId },
  relevance: { score: 1000, version: '1' },
  selectedLegalEntityId: companyId,
  title: 'Stale index title',
});

interface Scenario {
  readonly active?: boolean;
  readonly broad?: boolean;
  readonly company?: string;
  readonly currentDepartment?: string;
  readonly currentName?: string;
  readonly currentRole?: typeof employee.role | 'SUPPORT';
  readonly expected?: number | 'failure';
  readonly forgedHits?: boolean;
  readonly grantRevocation?: boolean;
  readonly malformedOwner?: boolean;
  readonly missing?: boolean;
  readonly moduleAllowed?: boolean;
  readonly noCompany?: boolean;
  readonly permissionUnavailable?: boolean;
  readonly principalTenant?: string;
  readonly query?: string;
  readonly resource?: boolean;
  readonly resourceBadKey?: boolean;
  readonly resourceRevocation?: boolean;
  readonly resourceUnavailable?: boolean;
  readonly self?: boolean;
  readonly selfRevocation?: boolean;
  readonly unavailableIndex?: boolean;
}

const checkDeniedWork = (scenario: Scenario, counts: { readonly indexReads: number; readonly ownerReads: number }) => {
  if (scenario.moduleAllowed === false || scenario.noCompany === true) {
    expect(counts.ownerReads).toBe(0);
    expect(counts.indexReads).toBe(0);
  }
  if (scenario.malformedOwner === true) {
    expect(counts.indexReads).toBe(0);
  }
};

const predicateFor = (
  broad: boolean,
  resource: boolean,
  selfGrant: boolean,
  badKey: boolean,
): ListAccessPredicate | undefined => {
  if (broad) {
    return { groups: [] };
  }
  const clauses: ListAccessClause[] = [];
  if (resource) {
    clauses.push({
      conditions: [
        Schema.decodeSync(ListAccessConditionSchema)({
          _tag: 'RecordKeyIn',
          recordKeys: [badKey ? otherCompanyId : employeeId],
        }),
      ],
    });
  }
  if (selfGrant) {
    clauses.push({
      conditions: [
        Schema.decodeSync(ListAccessConditionSchema)({
          _tag: 'AssignedTo',
          holder: { _tag: 'Principal', principalId },
        }),
      ],
    });
  }
  const [first, ...rest] = clauses;
  return first === undefined ? undefined : { groups: [{ clauses: [first, ...rest] }] };
};
const answerFor = (scenario: Scenario, predicate: ListAccessPredicate | undefined): TestGateAnswer => {
  if (scenario.permissionUnavailable === true || scenario.resourceUnavailable === true) {
    return { outcome: 'UNAVAILABLE' };
  }
  if (scenario.moduleAllowed === false || predicate === undefined) {
    return { outcome: 'DENIED' };
  }
  return { outcome: 'ALLOWED', predicate };
};

const scenarioEmployees = (
  scenario: Scenario,
  company: string,
  currentName: string,
  self: boolean,
): (typeof WorkforceStateSchema.Encoded)['employees'] => {
  if (scenario.missing === true || company !== companyId) {
    return [];
  }
  const current = {
    ...employee,
    active: scenario.active ?? true,
    department: scenario.currentDepartment ?? employee.department,
    fullName: currentName,
    role: scenario.currentRole ?? employee.role,
  };
  return self
    ? [{ ...current, principalRef: { principalId, tenantId: scenario.principalTenant ?? tenantId } }]
    : [current];
};

const checkCanonical = Effect.fn('Workforce.testCanonicalSearch')(function* checkCanonical(
  scenario: Scenario,
  currentPredicate: ListAccessPredicate | undefined,
  employees: (typeof WorkforceStateSchema.Encoded)['employees'],
  visibleIds: readonly string[],
  trusted: Parameters<typeof finishWorkforceRecords>[3],
) {
  // Full canonical records finish and the narrow search finish must agree on active visible IDs.
  const state = yield* Schema.encodeEffect(WorkforceStateSchema)(
    Schema.decodeUnknownSync(WorkforceStateSchema)({ employees }),
  );
  const predicate = currentPredicate;
  if (predicate === undefined) {
    return yield* Effect.die('A successful canonical read must have its predicate');
  }
  const canonical = yield* finishWorkforceRecords(
    { active: true },
    { aiActivity: [], availablePrincipals: [], row: { revision: 1, state } },
    { predicate, readAll: predicate.groups.length === 0, writeAll: false },
    trusted,
  );
  if (scenario.currentName === undefined && scenario.query === undefined && scenario.forgedHits !== true) {
    expect(visibleIds).toEqual(canonical.items.map((row) => row.id));
  }
  return canonical;
});

/** Real ReadRuntime/factory/Drizzle mapping, with only SQL and authorization transports mocked. No projection producer. */
const runScenario = Effect.fn('Workforce.testSearch')(function* runScenario(scenario: Scenario) {
  const { broad: initialBroad = false, company = companyId, currentName: initialName = employee.fullName } = scenario;
  let broad = initialBroad;
  let currentName = initialName;
  const trusted =
    scenario.noCompany === true ? Struct.omit(principal, ['legalEntityId']) : { ...principal, legalEntityId: company };
  let resource = scenario.resource ?? false;
  let self = scenario.self ?? false;
  let ownerReads = 0;
  let indexReads = 0;
  const currentEmployees = () => scenarioEmployees(scenario, company, currentName, self);
  const readKey = employeesRead.descriptor.accessDeclaration?.key;
  if (readKey === undefined) {
    return yield* Effect.die('The registered search must declare its capability');
  }
  const answers: Record<string, TestGateAnswer> = {};
  const gate = makeTestBoundAccessGate({ answers, defaultAnswer: { outcome: 'DENIED' } });
  let currentPredicate: ListAccessPredicate | undefined;
  const refreshDecision = () => {
    currentPredicate = predicateFor(broad, resource, scenario.self === true, scenario.resourceBadKey === true);
    answers[readKey] = answerFor(scenario, currentPredicate);
  };
  const harness = yield* makeReadTestHarness({
    accessDecision: gate.bound,
    compositionRevision: 'a'.repeat(64),
    executeOwnerQuery: ({ params, scope, sql }) => {
      ownerReads += 1;
      expect(scope).toEqual({ legalEntityId: company, tenantId });
      const predicate = currentPredicate;
      if (predicate === undefined) {
        return Effect.die('Denied search must not load owner SQL');
      }
      const reach = new PgDialect().sqlToQuery(recordReachSql(predicate, drizzleSql`employee`, tenantId));
      expect(params).toEqual([...reach.params, tenantId, company, 1]);
      expect(sql).toContain(reach.sql);
      expect(sql).toContain('"demo_workforce"."workforce_states"');
      expect(sql).toContain('jsonb_array_elements');
      expect(sql).toContain("employee->'fullName'");
      expect(sql).toContain("employee->'department'");
      expect(sql).toContain("employee->'role'");
      expect(sql).not.toMatch(/email|phone|address|core_principals|auth\.|audit|select\s+"state"/iu);
      // Scripted transport returns only the explicit SQL projection, not the full private state.
      if (scenario.missing === true || company !== companyId) {
        return Effect.succeed([]);
      }
      if (scenario.malformedOwner === true) {
        return Effect.succeed([{ employees: null }]);
      }
      return Effect.succeed([
        {
          // Model the already-asserted SQL predicate. A forged foreign-tenant projection deliberately
          // crosses the transport seam so the owner's post-commit integrity check is also exercised.
          employees: currentEmployees()
            .filter(
              (row) =>
                scenario.principalTenant !== undefined ||
                recordVisible(predicate, Schema.decodeUnknownSync(WorkforceSearchEmployeeSchema)(row), tenantId),
            )
            .map((row) => Struct.pick(row, ['active', 'department', 'fullName', 'id', 'principalRef', 'role'])),
        },
      ]);
    },
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T00:00:00.000Z')),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: workforceRegistration,
    scope: trusted,
  });
  const invoke = Effect.suspend(() => {
    refreshDecision();
    return harness.runtime.runRead({
      input: { query: scenario.query ?? 'jiri' },
      principal: trusted,
      registration: employeesRead,
      transport: { correlationId: principal.correlationId },
    });
  }).pipe(
    Effect.provide(harness.layer),
    Effect.provideService(AccessDecisionGate, gate.accessDecision),
    Effect.provideService(CoreSearchQueryRuntime, {
      search: (input, scope) => {
        indexReads += 1;
        expect(harness.snapshot().statements.some((sql) => /^commit$/iu.test(sql))).toBe(true);
        expect(scope).toEqual(trusted);
        expect(input).toEqual({
          includeArchived: false,
          includeRelevance: true,
          moduleId: 'demo.workforce',
          query: scenario.query ?? 'jiri',
          resourceType: 'demo.workforce.employee',
          selectedLegalEntityId: company,
          tenantId,
        });
        if (scenario.unavailableIndex === true) {
          return Effect.fail(
            new CoreSearchProjectionUnavailable({
              code: 'core_search_projection_unavailable',
              reason: 'Mock: owner unit test has no ready projection',
            }),
          );
        }
        return Effect.succeed(
          scenario.forgedHits === true
            ? [
                hit,
                { ...hit, archived: true },
                Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
                  ...hit,
                  selectedLegalEntityId: otherCompanyId,
                }),
                Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
                  ...hit,
                  ref: { ...hit.ref, tenantId: otherCompanyId },
                }),
                Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
                  ...hit,
                  ref: { ...hit.ref, moduleId: 'demo.crm' },
                }),
                Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
                  ...hit,
                  ref: { ...hit.ref, resourceType: 'demo.workforce.other' },
                }),
                Schema.decodeUnknownSync(CoreSearchProjectionHitSchema)({
                  ...hit,
                  ref: { ...hit.ref, resourceId: otherCompanyId },
                }),
              ]
            : [hit],
        );
      },
    }),
  );
  const outcome = yield* Effect.exit(invoke);
  if (scenario.expected === 'failure') {
    expect(Exit.isFailure(outcome)).toBe(true);
    checkDeniedWork(scenario, { indexReads, ownerReads });
    return [];
  }
  expect(Exit.isSuccess(outcome)).toBe(true);
  if (Exit.isFailure(outcome)) {
    return [];
  }
  const result = outcome.value;
  expect(result.length).toBe(scenario.expected ?? 1);
  expect(Schema.is(EmployeesProviderResponseSchema)(result)).toBe(true);
  for (const row of result) {
    expect(new Set(Object.keys(row))).toEqual(new Set(['ref', 'relevance', 'selectedLegalEntityId', 'title']));
    expect(row.title).toBe(currentName);
    expect(row.ref).toEqual(hit.ref);
  }
  expect(JSON.stringify(result)).not.toMatch(/private|@|777|Stale index|principalRef|department|ACCOUNTANT/u);
  expect(harness.snapshot().evidenceWrites).toBe(1);
  yield* checkCanonical(
    scenario,
    currentPredicate,
    currentEmployees(),
    result.map((row) => row.ref.resourceId),
    trusted,
  );
  expect(gate.accessDecision.askedLists[0]?.carrier.accessDeclaration).toEqual(
    employeesRead.descriptor.accessDeclaration,
  );
  expect(gate.accessDecision.askedLists[0]?.scope).toEqual(trusted);
  expect(gate.accessDecision.askedDecisions).toEqual([]);
  if (scenario.resourceRevocation === true) {
    resource = false;
    expect(yield* Effect.isFailure(invoke)).toBe(true);
    expect(ownerReads).toBe(1);
    expect(indexReads).toBe(1);
  }
  if (scenario.selfRevocation === true) {
    self = false;
    expect(yield* invoke).toEqual([]);
    expect(ownerReads).toBe(2);
    expect(indexReads).toBe(2);
  }
  if (scenario.grantRevocation === true) {
    broad = false;
    expect(yield* Effect.isFailure(invoke)).toBe(true);
    broad = true;
    currentName = 'Nové jméno';
    expect(yield* invoke).toEqual([]);
    currentName = employee.fullName;
    expect((yield* invoke).length).toBe(1);
    expect(ownerReads).toBe(3);
    expect(indexReads).toBe(3);
    // Core also records the refused read, without running owner or index work.
    expect(harness.snapshot().evidenceWrites).toBe(4);
  }
  return result;
});

const scenarios: readonly [string, Scenario][] = [
  ['current all-in-scope predicate grants visibility', { broad: true }],
  ['current resource read grants visibility', { resource: true }],
  ['resource revocation is observed on the next request', { resource: true, resourceRevocation: true }],
  ['removal of the current self binding is observed on the next request', { self: true, selfRevocation: true }],
  ['missing selected company denies before owner/index work', { broad: true, expected: 'failure', noCompany: true }],
  [
    'malformed owner projection is unavailable, not a fake no-match',
    { broad: true, expected: 'failure', malformedOwner: true },
  ],
  ['assigned self visibility needs no explicit-record grant', { self: true }],
  ['module access alone cannot expose employees', { expected: 'failure' }],
  ['module permission denied before owner/index work', { broad: true, expected: 'failure', moduleAllowed: false }],
  ['inactive owner cannot match a positive shortlist', { active: false, broad: true, expected: 0 }],
  ['missing owner cannot match a positive shortlist', { broad: true, expected: 0, missing: true }],
  ['other actual selected company cannot use original owner', { broad: true, company: otherCompanyId, expected: 0 }],
  ['changed current name rejects stale shortlist', { broad: true, currentName: 'Nový pracovník', expected: 0 }],
  ['role lookup returns the current name only', { broad: true, currentName: 'Nový pracovník', query: 'accountant' }],
  [
    'full 200-character meaningful query reaches Core unchanged',
    { broad: true, currentName: 'a'.repeat(200), query: 'a'.repeat(200) },
  ],
  ['department lookup folds Czech diacritics', { query: 'ucetni oddeleni', resource: true }],
  [
    'changed role cannot match stale indexed role',
    { broad: true, currentRole: 'SUPPORT', expected: 0, query: 'accountant' },
  ],
  [
    'changed department cannot match stale indexed department',
    { broad: true, currentDepartment: 'Sklad', expected: 0, query: 'ucetni' },
  ],
  ['inactive self owner is excluded despite current self binding', { active: false, expected: 0, self: true }],
  [
    'indeterminate resource decision fails closed even for self',
    { expected: 'failure', resourceUnavailable: true, self: true },
  ],
  [
    'a canonical predicate for another record cannot authorize the current row',
    { expected: 0, resource: true, resourceBadKey: true },
  ],
  ['multi-token name/role/department rematch', { query: 'jiri accountant oddeleni', self: true }],
  ['email is never searchable current evidence', { broad: true, expected: 0, query: employee.email }],
  ['phone is never searchable current evidence', { broad: true, expected: 0, query: employee.phone }],
  ['forged scope/type/archive/absent-resource hits are discarded', { broad: true, forgedHits: true }],
  [
    'a forged cross-tenant self projection fails closed',
    { expected: 'failure', principalTenant: otherCompanyId, self: true },
  ],
  [
    'indeterminate canonical decision is not self/all success',
    { expected: 'failure', permissionUnavailable: true, self: true },
  ],
  [
    'Core readiness failure is unavailable, never fake no-match success',
    { broad: true, expected: 'failure', unavailableIndex: true },
  ],
  ['fresh requests see revocation and renamed owner without cache', { broad: true, grantRevocation: true }],
];
for (const [name, scenario] of scenarios) {
  it.effect(name, () => runScenario(scenario).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));
}

it('uses meaningful Core query semantics through 200 characters, never blank/over-limit', () => {
  for (const query of ['', ' ', '\u0301', 'a'.repeat(201)]) {
    expect(Schema.is(EmployeesProviderRequestSchema)({ query })).toBe(false);
  }
  expect(Schema.is(EmployeesProviderRequestSchema)({ query: 'a'.repeat(200) })).toBe(true);
  expect(Schema.decodeUnknownSync(EmployeesProviderRequestSchema)({ query: '  Jiří  ' })).toEqual({ query: 'Jiří' });
  expect(Schema.is(WorkforceSearchEmployeeSchema)(Struct.omit(employee, ['email', 'phone']))).toBe(true);
  expect(
    Schema.is(EmployeesProviderResponseSchema)([
      { ref: { ...hit.ref, resourceType: 'demo.crm.client' }, title: 'Name' },
    ]),
  ).toBe(false);
});

it('retains canonical module/context admission and the registered row-scoped declaration', () => {
  expect(employeesRead.descriptor.legalEntityScope).toBe('required');
  expect(employeesRead.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(employeesRead.descriptor.accessDeclaration?.selectors).toEqual(['all', 'assigned']);
  expect(decideModuleStateAccess('archived', employeesRead.descriptor.entrypoint.access)).toBe('deny');
});
