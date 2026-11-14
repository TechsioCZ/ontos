import { EmployeeIdSchema } from '../../shared/apis/records.ts';
import { defineDatabaseIdentityEnrollment, SHARED_RUNTIME_IDENTITY } from '@app/core-runtime';
import {
  makeActionTestAccessFences,
  makeActionTestHarness,
  bindActionTestServices,
} from '@app/core-runtime/testing/actions';
import type { ActionTestAccessFenceQuery } from '@app/core-runtime/testing/actions';
import { makePersistedActionTestAccessGate, makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import {
  AccessScopeIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RecordKeySchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { PgClient } from '@effect/sql-pg';
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema, UpdateEmployeePayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { updateEmployeeAction } from '../../src/actions/update-employee.action.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { evolveEmployeeState } from '../../src/services/persistence.service.ts';
import { workforceRegistration } from '../../vertical.registration.ts';
import { recordsCarrier } from '../../shared/access-declarations.ts';
import { employee, employeeId, otherEmployeeId, scope } from './workforce-search-fixtures.ts';

const thirdId = '50000000-0000-4000-8000-000000000003';
const payload = Schema.decodeUnknownSync(UpdateEmployeePayloadSchema)({
  command: { _tag: 'BulkUpdateEmployees', ids: [otherEmployeeId, employeeId, thirdId], patch: { active: false } },
  expectedRevision: 1,
});
const now = DateTime.makeUnsafe('2026-11-04T01:00:00.000Z');
const state = {
  employees: [
    employee,
    { ...employee, email: 'second@example.test', id: otherEmployeeId },
    { ...employee, email: 'third@example.test', id: EmployeeIdSchema.make(thirdId) },
  ],
};

type CanonicalPorts = Parameters<typeof makePersistedActionTestAccessGate>[0]['ports'];
type Authority = ReturnType<CanonicalPorts['intent']['authorityFor']>;
type AuthorityCell = Effect.Success<ReturnType<Authority['readCells']>>[number];
type AccessFences = Effect.Success<ReturnType<typeof makeActionTestAccessFences>>;
const tenantScopeId = AccessScopeIdSchema.make('80000000-0000-4000-8000-000000000001');
const companyScopeId = AccessScopeIdSchema.make('80000000-0000-4000-8000-000000000002');
const tenantId = TenantIdSchema.make(scope.tenantId);
const companyId = LegalEntityIdSchema.make(scope.legalEntityId);
const principalId = PrincipalIdSchema.make(scope.principalId);
const holder = { _tag: 'Principal', principalId } as const;
const fenceStates = ['Ready', 'Changing', 'missing-company'] as const;
type FenceState = (typeof fenceStates)[number];
const scopeValues = Schema.Tuple([Schema.String, Schema.String]);
const enginePermissions = new Set([
  'access_grant:use:principal',
  'access_capability:run_all_grant:access_grant',
  'access_assignment:eligible:principal',
  'access_role_binding:member:access_assignment',
]);
const engineAnswer = (item: Parameters<CanonicalPorts['check']['checkBulk']>[0][number]) => ({
  permissionship: enginePermissions.has(`${item.resource.type}:${item.permission}:${item.subject.type}`)
    ? ('has' as const)
    : ('none' as const),
});
const normalizeSql = (sql: string) => sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
const installAndReadScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";

/** The public production currentness reader and the Action writer share these exact database rows. */
const fenceDatabase = (fences: AccessFences) =>
  Effect.gen(function* fixtureCoreDatabase() {
    let installedTenant = '';
    let installedCompany = '';
    const connection = testSqlConnection((sql, params) =>
      Effect.gen(function* fenceStatement() {
        const statement = normalizeSql(sql);
        if (['begin', 'commit', 'rollback'].includes(statement)) {
          return [];
        }
        // Main's scope authority probes the connected role before it installs a scope.
        if (statement === 'select current_user::text as role') {
          return [{ role: SHARED_RUNTIME_IDENTITY.role }];
        }
        // A session-setting role installs its scope and reads back the connected role in one statement.
        if (statement === installAndReadScopeSql) {
          [installedTenant, installedCompany] = yield* Schema.decodeUnknownEffect(scopeValues)(params).pipe(
            Effect.orDie,
          );
          return [
            {
              legal_entity_id: installedCompany,
              role: SHARED_RUNTIME_IDENTITY.role,
              tenant_id: installedTenant,
            },
          ];
        }
        const query: ActionTestAccessFenceQuery = {
          params,
          scope: { legalEntityId: installedCompany, tenantId: installedTenant },
          sql,
        };
        const answer = fences.read(query);
        return Option.isSome(answer)
          ? yield* answer.value
          : yield* Effect.die(`The fence fixture must not execute owner or unlisted SQL: ${sql}`);
      }),
    );
    const reactivity = yield* Reactivity.make;
    const services = yield* Layer.build(scriptedPgClientLayer(Effect.succeed(connection))).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    return yield* testCoreDatabase.pipe(
      Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
    );
  });

const bulkAuthority = (refuseMiddle: boolean): Authority => {
  const actionTargets = [
    RecordKeySchema.make(employeeId),
    ...(refuseMiddle ? [] : [RecordKeySchema.make(otherEmployeeId)]),
    RecordKeySchema.make(thirdId),
  ] as const;
  const allTargets = [
    RecordKeySchema.make(employeeId),
    RecordKeySchema.make(otherEmployeeId),
    RecordKeySchema.make(thirdId),
  ] as const;
  const cells: readonly AuthorityCell[] = [
    {
      assignedAt: new Date(0),
      assignedBy: principalId,
      assignmentIncarnationId: AssignmentIncarnationIdSchema.make('70000000-0000-4000-8000-000000000003'),
      capabilityKey: Schema.decodeUnknownSync(CapabilityKeySchema)(
        updateEmployeeAction.descriptor.accessDeclaration?.key,
      ),
      grantIncarnationId: GrantIncarnationIdSchema.make('70000000-0000-4000-8000-000000000004'),
      holder,
      mode: 'run',
      roleId: RoleIdSchema.make('70000000-0000-4000-8000-000000000001'),
      roleRevisionId: RoleRevisionIdSchema.make('70000000-0000-4000-8000-000000000002'),
      selector: { _tag: 'targets', recordKeys: actionTargets },
    },
    {
      assignedAt: new Date(0),
      assignedBy: principalId,
      assignmentIncarnationId: AssignmentIncarnationIdSchema.make('70000000-0000-4000-8000-000000000003'),
      capabilityKey: Schema.decodeUnknownSync(CapabilityKeySchema)(recordsRead.descriptor.accessDeclaration?.key),
      grantIncarnationId: GrantIncarnationIdSchema.make('70000000-0000-4000-8000-000000000005'),
      holder,
      mode: 'run',
      roleId: RoleIdSchema.make('70000000-0000-4000-8000-000000000001'),
      roleRevisionId: RoleRevisionIdSchema.make('70000000-0000-4000-8000-000000000002'),
      selector: { _tag: 'targets', recordKeys: allTargets },
    },
  ];
  return {
    readCells: (query) => {
      expect(query.tenantId).toBe(tenantId);
      expect(query.scopeId).toBe(companyScopeId);
      expect(Predicate.isTagged(query.holder, 'Principal') ? query.holder.principalId : undefined).toBe(principalId);
      return Effect.succeed(
        cells.filter((cell) => cell.capabilityKey === query.capabilityKey && cell.mode === query.mode),
      );
    },
    readCompanyOwnership: (query) => Effect.succeed(query.tenantId === tenantId && query.legalEntityId === companyId),
    readConnection: () => Effect.succeed(Option.none()),
    readScope: (query) => {
      expect(query.tenantId).toBe(tenantId);
      expect(query.legalEntityId).toBe(companyId);
      expect(query.holders).toEqual([holder]);
      return Effect.succeed(
        Option.some({
          deadlines: [],
          holderDeadlines: [{ deadlines: [], holder }],
          scope: { _tag: 'LegalEntity', legalEntityId: companyId, tenantId },
          scopeId: companyScopeId,
          tenantId,
        }),
      );
    },
    readTeamIds: () => Effect.succeed([]),
  };
};

const persistedBulkGate = (
  refuseMiddle: boolean,
  fenceState: FenceState,
  transactionCount: () => number,
  observe: (question: GateInput) => void,
) =>
  Effect.gen(function* preparedBulkGate() {
    const fences = yield* makeActionTestAccessFences([
      { revision: 7, scopeId: tenantScopeId, state: 'Ready', tenantId },
      ...(fenceState === 'missing-company'
        ? []
        : [{ legalEntityId: companyId, revision: 11, scopeId: companyScopeId, state: fenceState, tenantId }]),
    ]);
    const executor = yield* fenceDatabase(fences);
    const authority = bulkAuthority(refuseMiddle);
    let remoteChecks = 0;
    const gate = yield* makePersistedActionTestAccessGate({
      database: { enrollment: defineDatabaseIdentityEnrollment([]), executor },
      ports: {
        candidates: { listCandidateIds: () => Effect.succeed([companyId]) },
        check: {
          checkBulk: (items) =>
            Effect.sync(() => {
              expect(transactionCount()).toBe(0);
              remoteChecks += 1;
              return items.map(engineAnswer);
            }),
        },
        decisionLog: { record: () => Effect.void },
        intent: { authorityFor: () => authority, joined: () => ({ authorityFor: () => authority }) },
        principalKinds: {
          readKind: (query) => {
            expect(query.principalId).toBe(principalId);
            return Effect.succeed(Option.some('human' as const));
          },
        },
      },
    });
    const prepare = Option.getOrThrow(Option.fromUndefinedOr(gate.prepare));
    return {
      bound: {
        ...gate,
        prepare: (question: GateInput) =>
          Effect.sync(() => {
            expect(transactionCount()).toBe(0);
            observe(question);
          }).pipe(Effect.andThen(prepare(question))),
      },
      fences,
      remoteChecks: () => remoteChecks,
    };
  });

it('the published employee.update owns bulk mutation and apply-command publishes creation only', () => {
  const encoded = Schema.encodeSync(UpdateEmployeePayloadSchema)(payload);
  expect(Schema.is(ApplyCommandPayloadSchema)(payload)).toBe(false);
  expect(Schema.is(UpdateEmployeePayloadSchema)(payload)).toBe(true);
  expect(Predicate.isTagged(encoded.command, 'BulkUpdateEmployees')).toBe(true);
});
const noTransactions = (): number => 0;
for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
  it.effect(`the original owner records Read independently refuses every bulk target: ${outcome}`, () =>
    Effect.scoped(
      Effect.gen(function* governingReadRefusal() {
        const gate = makeTestBoundAccessGate({
          answers: {
            'demo.workforce.employee.update': { outcome: 'ALLOWED' },
            [recordsCarrier.accessDeclaration.key]: { outcome },
          },
        });
        const harness = yield* makeActionTestHarness({
          accessDecision: gate.bound,
          ownerRegistration: workforceRegistration,
          services: [
            bindActionTestServices(updateEmployeeAction, {
              apply: () => Effect.die('A denied or unavailable governing Read must not write any employee'),
              loadRecords: () => Effect.die('Governing-read authority must not invoke the records handler'),
            }),
          ],
        });
        const failure = yield* harness.runtime
          .runAction({
            payload,
            principal: scope,
            registration: updateEmployeeAction,
            transport: { correlationId: 'bulk-read-refusal', idempotencyKey: `bulk-read-${outcome}` },
          })
          .pipe(Effect.flip);
        expect(
          Predicate.isTagged(failure, outcome === 'DENIED' ? 'ActionPermissionDenied' : 'ActionPermissionCheckError'),
        ).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
        for (const declaration of [
          updateEmployeeAction.descriptor.accessDeclaration,
          recordsRead.descriptor.accessDeclaration,
        ]) {
          const questions = gate.accessDecision.askedDecisions.filter(
            ({ carrier }) => carrier.accessDeclaration?.key === declaration?.key,
          );
          expect(questions.map(({ target }) => target?.recordKey)).toEqual([employeeId, otherEmployeeId, thirdId]);
          expect(questions.every(({ mode }) => mode === 'run')).toBe(true);
          expect(questions.every(({ carrier }) => carrier.accessDeclaration === declaration)).toBe(true);
        }
      }),
    ),
  );
}
for (const refuseMiddle of [false, true]) {
  it.effect(`every supplied employee target is checked before one atomic handler, middle refusal=${refuseMiddle}`, () =>
    Effect.scoped(
      Effect.gen(function* completeSet() {
        const asked: string[] = [];
        const readTargets: string[] = [];
        let transactionCount = noTransactions;
        let writes = 0;
        const gate = yield* persistedBulkGate(
          refuseMiddle,
          'Ready',
          () => transactionCount(),
          (input) => {
            expect(transactionCount()).toBe(0);
            const declaration = input.carrier.accessDeclaration;
            const ownerRead = declaration?.key === recordsRead.descriptor.accessDeclaration?.key;
            expect(declaration).toBe(
              ownerRead ? recordsRead.descriptor.accessDeclaration : updateEmployeeAction.descriptor.accessDeclaration,
            );
            // The owner Read keeps its independent RUN authority. This direct invocation runs the
            // Action in RUN; a mandate uses APPROVE without changing the Read's mode.
            expect(input.mode).toBe('run');
            expect(input.target?.moduleKey).toBe('demo.workforce');
            expect(input.scope).toMatchObject({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
            const target = Option.getOrThrow(Option.fromUndefinedOr(input.target?.recordKey));
            (ownerRead ? readTargets : asked).push(target);
          },
        );
        const harness = yield* makeActionTestHarness({
          accessDecision: gate.bound,
          accessFences: gate.fences,
          ownerRegistration: workforceRegistration,
          services: [
            bindActionTestServices(updateEmployeeAction, {
              apply: (command, expectedRevision) =>
                evolveEmployeeState(state, command, { now }).pipe(
                  Effect.map((change) => {
                    writes += 1;
                    expect(command).toEqual(payload.command);
                    return { employees: change.employees, revision: expectedRevision + 1 };
                  }),
                ),
              loadRecords: () => Effect.die('Bulk update cannot call the records read'),
            }),
          ],
        });
        transactionCount = () => harness.snapshot().transactionCount;
        const request = {
          payload,
          principal: scope,
          registration: updateEmployeeAction,
          transport: { correlationId: 'bulk-set', idempotencyKey: `bulk-set-${refuseMiddle}` },
        };
        if (refuseMiddle) {
          const failure = yield* harness.runtime.runAction(request).pipe(Effect.flip);
          expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
          expect(writes).toBe(0);
          expect(harness.snapshot().committed).toEqual([]);
        } else {
          const result = yield* harness.runtime.runAction(request);
          expect(new Set(result.employees.map(({ id }) => id))).toEqual(
            new Set([employeeId, otherEmployeeId, thirdId]),
          );
          expect(result.employees.every(({ active }) => !active)).toBe(true);
          expect(harness.snapshot().committed).toHaveLength(1);
          expect(harness.snapshot().committed[0]?.actionKey).toBe('demo.workforce.update-employee');
          expect(new Set(readTargets)).toEqual(new Set([employeeId, otherEmployeeId, thirdId]));
          expect(gate.remoteChecks()).toBeGreaterThan(0);
          const calls = asked.length;
          const readCalls = readTargets.length;
          const remoteCalls = gate.remoteChecks();
          const replay = yield* harness.runtime.runAction(request).pipe(Effect.flip);
          expect(Predicate.isTagged(replay, 'ActionAlreadyCommitted')).toBe(true);
          expect(asked).toHaveLength(calls);
          expect(readTargets).toHaveLength(readCalls);
          expect(gate.remoteChecks()).toBe(remoteCalls);
          expect(writes).toBe(1);
        }
        expect(new Set(asked)).toEqual(new Set([employeeId, otherEmployeeId, thirdId]));
      }),
    ),
  );
}
for (const ids of [[], [employeeId, employeeId]]) {
  it.effect(`an empty or duplicate bulk set (${ids.length} entries) fails before owner SQL`, () =>
    Effect.scoped(
      Effect.gen(function* invalidSet() {
        const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: workforceRegistration });
        const failure = yield* harness.runtime
          .runAction({
            payload: { command: { _tag: 'BulkUpdateEmployees', ids, patch: { active: false } }, expectedRevision: 1 },
            principal: scope,
            registration: updateEmployeeAction,
            transport: { correlationId: 'bad-bulk', idempotencyKey: `bad-bulk-${ids.length}` },
          })
          .pipe(Effect.flip);
        expect(
          Predicate.isTagged(failure, 'ActionPayloadValidationError') ||
            Predicate.isTagged(failure, 'ActionPermissionCheckError'),
        ).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toEqual([]);
      }),
    ),
  );
}
it.effect('the retired apply-command cannot execute even an otherwise allowed bulk payload', () =>
  Effect.scoped(
    Effect.gen(function* noAlias() {
      const harness = yield* makeActionTestHarness({ access: 'allowed', ownerRegistration: workforceRegistration });
      const failure = yield* harness.runtime
        .runAction({
          payload,
          principal: scope,
          registration: applyCommandAction,
          transport: { correlationId: 'retired-bulk', idempotencyKey: 'retired-bulk' },
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'ActionPayloadValidationError')).toBe(true);
      expect(harness.snapshot().transactionCount).toBe(0);
    }),
  ),
);
it.effect('one missing employee prevents the entire owner state transition', () =>
  Effect.gen(function* missingEmployee() {
    const failure = yield* evolveEmployeeState({ employees: [employee] }, payload.command, { now }).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'WorkforceNotFound')).toBe(true);
    expect(employee.active).toBe(true);
  }),
);

it.effect('expired admission and Changing or missing company fences never reach the employee handler', () =>
  Effect.scoped(
    Effect.gen(function* expiredAdmission() {
      const gate = makeTestBoundAccessGate({ defaultAnswer: { admissionDeadline: new Date(0), outcome: 'ALLOWED' } });
      const harness = yield* makeActionTestHarness({
        accessDecision: gate.bound,
        ownerRegistration: workforceRegistration,
        services: [
          bindActionTestServices(updateEmployeeAction, {
            apply: () => Effect.die('An expired target set must never execute a business write'),
            loadRecords: () => Effect.die('An expired target set must not load employees'),
          }),
        ],
      });
      yield* harness.runtime
        .runAction({
          payload,
          principal: scope,
          registration: updateEmployeeAction,
          transport: { correlationId: 'expired-set', idempotencyKey: 'expired-set' },
        })
        .pipe(Effect.flip);
      expect(harness.snapshot().committed).toEqual([]);
      for (const fenceState of ['Changing', 'missing-company'] as const) {
        let transactionCount = noTransactions;
        const persisted = yield* persistedBulkGate(
          false,
          fenceState,
          () => transactionCount(),
          () => {},
        );
        const fencedHarness = yield* makeActionTestHarness({
          accessDecision: persisted.bound,
          accessFences: persisted.fences,
          ownerRegistration: workforceRegistration,
          services: [
            bindActionTestServices(updateEmployeeAction, {
              apply: () => Effect.die('An unavailable company fence must never execute a business write'),
              loadRecords: () => Effect.die('An unavailable company fence must not load employees'),
            }),
          ],
        });
        transactionCount = () => fencedHarness.snapshot().transactionCount;
        const failure = yield* fencedHarness.runtime
          .runAction({
            payload,
            principal: scope,
            registration: updateEmployeeAction,
            transport: { correlationId: `fenced-${fenceState}`, idempotencyKey: `fenced-${fenceState}` },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);
        expect(persisted.remoteChecks()).toBe(0);
        expect(fencedHarness.snapshot().transactionCount).toBe(0);
        expect(fencedHarness.snapshot().committed).toEqual([]);
      }
    }),
  ),
);
