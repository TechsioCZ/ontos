import { Cause, Effect, Exit, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionProposalAcceptedSchema } from '../../src/actions/proposal-accepted.ts';
import type {
  ActionMandateDispatch,
  ActionProposalParkInput,
} from '../../src/access/approvals/action-mandate-dispatch.ts';
import { freezeActionCommandV2, resolveActionCommandV2 } from '../../src/access/approvals/action-command-v2.ts';
import { defineActionGoverningRead } from '../../src/actions/governing-read.ts';
import type { AccessIntentSource } from '../../src/access/decision/authority.ts';
import type { GateInput } from '../../src/access/enforcement/contract.ts';
import type { AccessDecisionLogEntry } from '../../src/access/enforcement/decision-log.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  LegalEntityIdSchema,
  ProposalIdSchema,
  RecordKeySchema,
} from '../../src/access/ids.ts';
import {
  defineAction,
  defineActionAccessTargets,
  validateActionDescriptorInput,
} from '../../src/actions/definition.ts';
import type { ActionAccessTargetsResolver, ActionTargetSetAdmission } from '../../src/actions/definition.ts';
import {
  ActionAlreadyCommitted,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionRequestHashConflict,
} from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { computeActionRequestHash } from '../../src/actions/repository.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import type { AccessEnforcementPorts, BoundAccessGate } from '../../src/operations/access-gate.ts';
import { refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { readFor } from '../support/action-command-v2.ts';
import { at, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const moduleKey = 'demo.bulk-fixture';
const actionKey = `${moduleKey}.update-employees`;
const capabilityKey = `${moduleKey}.employee.update`;
const salaryKey = `${moduleKey}.employee.write-salary`;
const company = LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000080');
const firstId = RecordKeySchema.make('employee-1');
const secondId = RecordKeySchema.make('employee-2');
const payloadSchema = Schema.Struct({
  employeeIds: Schema.Array(RecordKeySchema),
  salary: Schema.optionalKey(Schema.Number),
});
type Payload = typeof payloadSchema.Type;
const payload: Payload = { employeeIds: [firstId, secondId], salary: 100 };
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:bulk-fixture',
  authMethod: 'session',
  legalEntityId: company,
  principalId: person,
  tenantId: tenant,
});
const descriptor = {
  accessDeclaration: {
    key: capabilityKey,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'employee', level: 'extended' },
    risk: 'sensitive',
    selectors: ['all'],
  },
  accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${actionKey}.access.v1` },
  accessFieldGroups: [
    {
      fieldClass: 'salaries',
      fields: ['salary'],
      key: salaryKey,
      kind: 'field_write',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'employee', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
  ],
  actionKey,
  auditProfile: 'standard',
  domainErrorSchema: Schema.Never,
  domainEvents: {},
  entrypoint: defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: actionKey,
    moduleKey,
    role: 'action',
  }),
  idempotency: 'required',
  legalEntityScope: 'required',
  owningModuleKey: moduleKey,
  payloadSchema,
  policies: [],
  resultSchema: Schema.Struct({ count: Schema.Number }),
  schemaVersion: '1',
} as const;
const allTargets: ActionAccessTargetsResolver<Payload> = (decoded, scope) => {
  expect(scope.legalEntityId).toBe(company);
  expect(scope.tenantId).toBe(tenant);
  return decoded.employeeIds.map((recordKey) => ({ moduleKey, recordKey }));
};

const services = () => Effect.succeed(Object.freeze({}));

const fixture = (resolve: ActionAccessTargetsResolver<Payload> = allTargets, onPrepared: () => void = () => {}) => {
  const admissions: ActionTargetSetAdmission[] = [];
  const writes: string[][] = [];
  const action = defineAction(
    { ...descriptor, accessTargets: defineActionAccessTargets(resolve) },
    (decoded) =>
      Effect.sync(() => {
        writes.push([...decoded.employeeIds]);
        return { count: decoded.employeeIds.length };
      }),
    services,
    {
      prepareServices: (_decoded, context) =>
        Effect.sync(() => {
          onPrepared();
          if (context.targetSetAdmission !== undefined) {
            admissions.push(context.targetSetAdmission);
          }
          return services;
        }),
    },
  );
  const owner = makeTestOperationOwner({ actions: [action], moduleId: moduleKey });
  return { action, admissions, owner, writes };
};

/** Production gate and native witnesses, with only its storage/engine ports replaced. */
const canonicalGate = (
  options: {
    readonly authority?: AuthoritySpec;
    readonly failRecord?: string;
    readonly guardedRecord?: string;
    readonly prepared?: boolean;
  } = {},
) => {
  const authoritySpec = options.authority ?? {
    cells: [
      cell({ capability: capabilityKey, selector: { _tag: 'targets', recordKeys: [firstId, secondId] } }),
      cell({ capability: salaryKey }),
    ],
  };
  const authority = makeAuthority(authoritySpec);
  const check = makeCheck({ authority: authoritySpec });
  const logs: AccessDecisionLogEntry[] = [];
  const questions: GateInput[] = [];
  let revision = 1;
  let remoteCalls = 0;
  const intent: AccessIntentSource = {
    authorityFor: () => authority.port,
    joined: () => intent,
  };
  const ports: AccessEnforcementPorts = {
    candidates: { listCandidateIds: () => Effect.succeed([company]) },
    check: {
      checkBulk: (items) => {
        remoteCalls += 1;
        const recordKeys = new Set(items.map((item) => item.context?.['resource_key']));
        if (options.failRecord !== undefined && recordKeys.has(options.failRecord)) {
          return Effect.succeed([]);
        }
        const result = check.port.checkBulk(items);
        return options.guardedRecord !== undefined && recordKeys.has(options.guardedRecord)
          ? Effect.andThen(refuseInsideDatabaseTransaction('spicedb', 'bulk-fixture'), result)
          : result;
      },
    },
    decisionLog: {
      record: (entry) =>
        Effect.sync(() => {
          logs.push(entry);
        }),
    },
    intent,
    principalKinds: { readKind: () => Effect.succeed(Option.some('human')) },
  };
  const preparedPorts =
    options.prepared === true
      ? {
          ...ports,
          currentness: {
            read: () => Effect.sync(() => [{ revision, scopeId: 'fixture-persisted-scope' }]),
          },
        }
      : ports;
  const gate = bindAccessGate(
    makeAccessDecisionService({
      authorityFor: ports.intent.authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
    }),
    preparedPorts,
  );
  const bound: BoundAccessGate = {
    ...gate,
    decide: (question, transaction) => {
      questions.push(question);
      return gate.decide(question, transaction);
    },
  };
  return {
    advanceRevision: () => {
      revision += 2;
    },
    bound,
    logs,
    questions,
    remoteCalls: () => remoteCalls,
  };
};

const harnessFor = (subject: ReturnType<typeof fixture>, accessDecision: BoundAccessGate) =>
  makeActionTestHarness({
    accessDecision,
    applicationComposition: subject.owner.applicationComposition,
    expectedDeployment: subject.owner.expectedDeployment,
    ownerRegistration: subject.owner.ownerRegistration,
  });
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const scalarDispatch = (commandPayload: Payload) => {
  const calls: string[] = [];
  const parks: ActionProposalParkInput[] = [];
  const dispatch: ActionMandateDispatch = {
    claim: () =>
      Effect.sync(() => {
        calls.push('claim');
      }),
    commit: () =>
      Effect.sync(() => {
        calls.push('commit');
      }),
    loadParkedProposal: () => Effect.succeed(Option.none()),
    parkProposal: (input) =>
      Effect.sync(() => {
        parks.push(input);
        return {
          expiresAt: at('2027-01-01T00:00:00Z'),
          proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000081'),
        };
      }),
    prepare: (input) =>
      Effect.succeed({
        approverId: input.scope.principalId,
        command: {
          capabilityKey: CapabilityKeySchema.make(capabilityKey),
          payload: commandPayload,
          target: firstId,
        },
        commandDigest: CommandDigestSchema.make('a'.repeat(64)),
        mandateId: input.mandateId,
        proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000081'),
        scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000082'),
      }),
  };
  return { calls, dispatch, parks };
};

it('validates an opaque, mutually exclusive company-scoped target-set declaration', () => {
  const declaration = defineActionAccessTargets(allTargets);
  expect(Object.isFrozen(declaration)).toBe(true);
  expect(Object.keys(declaration)).toEqual(['kind']);
  const valid = { ...descriptor, accessTargets: declaration };
  expect(() => validateActionDescriptorInput(valid)).not.toThrow();
  for (const invalid of [
    { ...valid, accessTarget: allTargets },
    { ...valid, accessTargets: allTargets },
    { ...valid, accessTargets: { kind: 'record_set' } },
    { ...valid, legalEntityScope: 'optional' },
    { ...valid, accessDeclaration: { ...descriptor.accessDeclaration, selectors: [] } },
    { ...valid, accessReducesAuthority: () => true },
  ]) {
    expect(() => validateActionDescriptorInput(invalid)).toThrow();
  }
});

it.effect('admits every exact target and changed field before one handler and one commit', () =>
  Effect.gen(function* allTargetsAllowed() {
    const subject = fixture();
    const gate = canonicalGate();
    const harness = yield* harnessFor(subject, gate.bound);
    const result = yield* harness.runtime.runAction({
      payload,
      principal,
      registration: subject.action,
      transport: {
        correlationId: 'bulk-allowed',
        idempotencyKey: 'bulk-allowed',
        targetResourceId: 'forged-first-only',
      },
    });
    expect(result).toEqual({ count: 2 });
    expect(subject.writes).toEqual([[firstId, secondId]]);
    expect(harness.snapshot().committed).toHaveLength(1);
    expect(harness.snapshot().invocations).toHaveLength(1);
    expect(subject.admissions).toHaveLength(1);
    const [admission] = subject.admissions;
    expect(admission?.targetSet.targets.map((target) => target.recordKey)).toEqual([firstId, secondId]);
    expect(admission?.targetSet.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(admission?.targetDecisions).toHaveLength(2);
    expect(admission?.fieldDecisions).toHaveLength(2);
    expect(admission?.decision.evidence.length).toBeGreaterThanOrEqual(4);
    expect(admission?.mode).toBe('run');
    expect(admission?.requestHash).toBe(harness.snapshot().invocations[0]?.requestHash);
    expect(Object.isFrozen(admission?.targetSet.targets)).toBe(true);
    for (const key of [capabilityKey, salaryKey]) {
      expect(
        gate.questions
          .filter((question) => question.carrier.accessDeclaration?.key === key)
          .map((question) => question.target?.recordKey),
      ).toEqual([firstId, secondId, firstId, secondId]);
    }
    expect(gate.questions.every((question) => question.mode === 'run')).toBe(true);
    expect(harness.snapshot().committed[0]?.transport.targetResourceId).toBe(admission?.targetSet.hash);
  }),
);

it.effect('replans every target and field under the writer guard without any remote gate call', () =>
  Effect.gen(function* preparedCompleteSetExecution() {
    const gate = canonicalGate({ guardedRecord: firstId, prepared: true });
    let preparedCalls = 0;
    const subject = fixture(allTargets, () => {
      preparedCalls = gate.remoteCalls();
    });
    const harness = yield* harnessFor(subject, gate.bound);
    const result = yield* harness.runtime.runAction({
      payload,
      principal,
      registration: subject.action,
      transport: { correlationId: 'prepared-bulk', idempotencyKey: 'prepared-bulk' },
    });
    expect(result).toEqual({ count: 2 });
    expect(preparedCalls).toBeGreaterThanOrEqual(4);
    expect(gate.remoteCalls()).toBe(preparedCalls);
    expect(subject.writes).toEqual([[firstId, secondId]]);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('refuses a complete-set proof after the persisted revision changes before writer entry', () =>
  Effect.gen(function* changedCompleteSetRevision() {
    const gate = canonicalGate({ guardedRecord: firstId, prepared: true });
    const subject = fixture(allTargets, gate.advanceRevision);
    const harness = yield* harnessFor(subject, gate.bound);
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'stale-prepared-bulk', idempotencyKey: 'stale-prepared-bulk' },
      }),
    );
    expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
    expect(subject.writes).toEqual([]);
    expect(harness.snapshot().committed).toEqual([]);
    expect(harness.snapshot().permissionDenials).toEqual([]);
  }),
);

it.effect('mixed parent grants deny the whole invocation once without acquiring owner services', () =>
  Effect.gen(function* mixedParentGrants() {
    const subject = fixture();
    const gate = canonicalGate({
      authority: {
        cells: [cell({ capability: capabilityKey, selector: { _tag: 'targets', recordKeys: [firstId] } })],
      },
    });
    const harness = yield* harnessFor(subject, gate.bound);
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-denied', idempotencyKey: 'bulk-denied' },
      }),
    );
    const denial = failureOf(exit);
    expect(Schema.is(ActionPermissionDenied)(denial)).toBe(true);
    if (Schema.is(ActionPermissionDenied)(denial)) {
      expect(denial.reasons).toEqual(['deny.insufficient_grant']);
    }
    expect(gate.questions.map((question) => question.target?.recordKey)).toEqual([firstId, secondId]);
    expect(harness.snapshot().permissionDenials).toHaveLength(1);
    expect(harness.snapshot().committed).toEqual([]);
    expect(subject.admissions).toEqual([]);
    expect(subject.writes).toEqual([]);
  }),
);

it.effect('a field grant on only the first record never authorizes a bulk field write', () =>
  Effect.gen(function* mixedFieldGrants() {
    const subject = fixture();
    const gate = canonicalGate({
      authority: {
        cells: [
          cell({ capability: capabilityKey }),
          cell({ capability: salaryKey, selector: { _tag: 'targets', recordKeys: [firstId] } }),
        ],
      },
    });
    const harness = yield* harnessFor(subject, gate.bound);
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-field-denied', idempotencyKey: 'bulk-field-denied' },
      }),
    );
    expect(Schema.is(ActionPermissionDenied)(failureOf(exit))).toBe(true);
    expect(
      gate.questions
        .filter((question) => question.carrier.accessDeclaration?.key === salaryKey)
        .map((question) => [question.target?.recordKey, question.parentRead?.target?.recordKey]),
    ).toEqual([
      [firstId, firstId],
      [secondId, secondId],
    ]);
    expect(harness.snapshot().permissionDenials).toHaveLength(1);
    expect(subject.writes).toEqual([]);
  }),
);

it.effect('does not require a field grant when the command writes none of that group', () =>
  Effect.gen(function* absentFields() {
    const subject = fixture();
    const gate = canonicalGate({ authority: { cells: [cell({ capability: capabilityKey })] } });
    const harness = yield* harnessFor(subject, gate.bound);
    yield* harness.runtime.runAction({
      payload: { employeeIds: [firstId, secondId] },
      principal,
      registration: subject.action,
      transport: { correlationId: 'bulk-no-field', idempotencyKey: 'bulk-no-field' },
    });
    expect(subject.writes).toHaveLength(1);
    expect(gate.questions.every((question) => question.carrier.accessDeclaration?.key === capabilityKey)).toBe(true);
  }),
);

for (const [label, malformed] of [
  ['ALLOWED', 'ALLOWED'],
  ['{decision: allowed}', { decision: 'allowed' }],
  ['{}', {}],
] as const) {
  it.effect(`one owner answer outside the contract (${label}) among allowed targets refuses the whole set`, () =>
    Effect.gen(function* oneMalformedOwnerAnswer() {
      const subject = fixture();
      const gate = canonicalGate();
      let answers = 0;
      const harness = yield* makeActionTestHarness({
        accessDecision: gate.bound,
        applicationComposition: subject.owner.applicationComposition,
        expectedDeployment: subject.owner.expectedDeployment,
        onOwnerAuthorization: () => {
          answers += 1;
          // An untyped value, as a separately built owner unit could answer for the second record only.
          return answers === 2 ? Schema.decodeUnknownSync(Schema.Any)(malformed) : 'allowed';
        },
        ownerRegistration: subject.owner.ownerRegistration,
      });
      const exit = yield* Effect.exit(
        harness.runtime.runAction({
          payload,
          principal,
          registration: subject.action,
          transport: { correlationId: `bulk-odd-${label}`, idempotencyKey: `bulk-odd-${label}` },
        }),
      );
      expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
      expect(answers).toBe(2);
      expect(subject.writes).toEqual([]);
      expect(harness.snapshot().committed).toHaveLength(0);
    }),
  );
}

it.effect('any unavailable target is retryable, even beside a denied record', () =>
  Effect.gen(function* unavailableRecord() {
    const subject = fixture();
    const gate = canonicalGate({
      authority: {
        cells: [cell({ capability: capabilityKey, selector: { _tag: 'targets', recordKeys: [secondId] } })],
      },
      failRecord: secondId,
    });
    const harness = yield* harnessFor(subject, gate.bound);
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-unavailable', idempotencyKey: 'bulk-unavailable' },
      }),
    );
    expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
    expect(harness.snapshot().permissionDenials).toEqual([]);
    expect(subject.writes).toEqual([]);
  }),
);

it.effect('empty, duplicate, malformed, foreign-owner and unavailable target facts fail closed', () =>
  Effect.gen(function* invalidTargets() {
    const invalidResolvers: readonly ActionAccessTargetsResolver<Payload>[] = [
      () => [],
      () => [{ moduleKey, recordKey: '' }],
      () => [
        { moduleKey, recordKey: firstId },
        { moduleKey, recordKey: firstId },
      ],
      () => [{ moduleKey: 'other.owner', recordKey: firstId }],
      () => {
        throw new Error('Owner target facts unavailable');
      },
    ];
    for (const resolve of invalidResolvers) {
      const subject = fixture(resolve);
      const gate = canonicalGate();
      const harness = yield* harnessFor(subject, gate.bound);
      const exit = yield* Effect.exit(
        harness.runtime.runAction({
          payload,
          principal,
          registration: subject.action,
          transport: { correlationId: 'bulk-invalid', idempotencyKey: 'bulk-invalid' },
        }),
      );
      expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
      expect(gate.questions).toEqual([]);
      expect(subject.writes).toEqual([]);
      expect(harness.snapshot().invocations).toEqual([]);
    }
  }),
);

it.effect('keeps every needed witness and the earliest target or field admission deadline', () =>
  Effect.gen(function* earliestDeadlinePreserved() {
    const subject = fixture();
    const earliest = at('2027-01-01T00:00:00Z');
    const gate = canonicalGate({
      authority: {
        cells: [
          cell({
            capability: capabilityKey,
            deadline: at('2027-02-01T00:00:00Z'),
            role: 51,
            selector: { _tag: 'targets', recordKeys: [firstId] },
          }),
          cell({
            capability: capabilityKey,
            deadline: at('2027-03-01T00:00:00Z'),
            role: 52,
            selector: { _tag: 'targets', recordKeys: [secondId] },
          }),
          cell({ capability: salaryKey, deadline: earliest }),
        ],
      },
    });
    const harness = yield* harnessFor(subject, gate.bound);
    yield* harness.runtime.runAction({
      payload,
      principal,
      registration: subject.action,
      transport: { correlationId: 'bulk-deadline', idempotencyKey: 'bulk-deadline' },
    });
    const decision = subject.admissions[0]?.decision;
    expect(decision?.admissionDeadline).toEqual(earliest);
    expect(new Set(decision?.evidence.map((entry) => entry.witness.grantIncarnationId)).size).toBe(3);
    expect(decision?.selectors).toEqual([]);
  }),
);

it.effect('replays a committed request without another write and conflicts on payload or target-set changes', () =>
  Effect.gen(function* originalRequestBinding() {
    let currentIds: readonly string[] = [firstId, secondId];
    const subject = fixture(() => currentIds.map((recordKey) => ({ moduleKey, recordKey })));
    const harness = yield* harnessFor(subject, canonicalGate().bound);
    const request = {
      payload,
      principal,
      registration: subject.action,
      transport: { correlationId: 'bulk-replay', idempotencyKey: 'bulk-replay' },
    };
    yield* harness.runtime.runAction(request);
    expect(Schema.is(ActionAlreadyCommitted)(failureOf(yield* Effect.exit(harness.runtime.runAction(request))))).toBe(
      true,
    );
    const changedPayload = yield* Effect.exit(
      harness.runtime.runAction({ ...request, payload: { ...payload, salary: 200 } }),
    );
    expect(Schema.is(ActionRequestHashConflict)(failureOf(changedPayload))).toBe(true);
    currentIds = [firstId];
    expect(
      Schema.is(ActionRequestHashConflict)(failureOf(yield* Effect.exit(harness.runtime.runAction(request)))),
    ).toBe(true);
    expect(subject.writes).toHaveLength(1);
    expect(harness.snapshot().invocations).toHaveLength(1);
  }),
);

it.effect('keeps the existing single-record request hash when a target-set resolver returns one record', () =>
  Effect.gen(function* singleRecordHashCompatibility() {
    const subject = fixture();
    const harness = yield* harnessFor(subject, canonicalGate().bound);
    const singleton = { employeeIds: [firstId], salary: 100 };
    yield* harness.runtime.runAction({
      payload: singleton,
      principal,
      registration: subject.action,
      transport: { correlationId: 'single-set', idempotencyKey: 'single-set' },
    });
    expect(harness.snapshot().invocations[0]?.requestHash).toBe(
      computeActionRequestHash({
        actionKey,
        normalizedPayload: singleton,
        owningModuleKey: moduleKey,
        principal,
        schemaVersion: '1',
        target: { targetModuleKey: moduleKey, targetResourceId: firstId, targetResourceType: capabilityKey },
      }),
    );
    expect(harness.snapshot().committed[0]?.transport.targetResourceId).toBe(firstId);
    expect(subject.admissions[0]?.targetSet.targets).toHaveLength(1);
  }),
);

it.effect('canonicalizes a complete target set without changing payload order or replay identity', () =>
  Effect.gen(function* targetEnumerationOrder() {
    let reverse = true;
    const subject = fixture((decoded) =>
      (reverse ? decoded.employeeIds.toReversed() : decoded.employeeIds).map((recordKey) => ({ moduleKey, recordKey })),
    );
    const harness = yield* harnessFor(subject, canonicalGate().bound);
    const request = {
      payload,
      principal,
      registration: subject.action,
      transport: { correlationId: 'target-order', idempotencyKey: 'target-order' },
    };
    yield* harness.runtime.runAction(request);
    reverse = false;
    const retry = yield* Effect.exit(harness.runtime.runAction(request));
    expect(Schema.is(ActionAlreadyCommitted)(failureOf(retry))).toBe(true);
    expect(subject.writes).toEqual([[firstId, secondId]]);
    expect(subject.admissions[0]?.targetSet.targets.map((target) => target.recordKey)).toEqual([firstId, secondId]);
  }),
);

it.effect('rechecks all records under the fence and blocks a revocation after preparation', () =>
  Effect.gen(function* revokedSecondTarget() {
    const subject = fixture();
    const granted = canonicalGate();
    const revoked = canonicalGate({
      authority: { cells: [cell({ capability: capabilityKey, selector: { _tag: 'targets', recordKeys: [firstId] } })] },
    });
    let fenceHeld = false;
    const accessDecision: BoundAccessGate = {
      ...granted.bound,
      decide: (question, transaction) => (fenceHeld ? revoked : granted).bound.decide(question, transaction),
    };
    const harness = yield* makeActionTestHarness({
      accessDecision,
      lockAccessExecutionFence: () =>
        Effect.sync(() => {
          fenceHeld = true;
        }),
      ownerRegistration: subject.owner.ownerRegistration,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-revoked', idempotencyKey: 'bulk-revoked' },
      }),
    );
    expect(Schema.is(ActionPermissionDenied)(failureOf(exit))).toBe(true);
    expect(revoked.questions.map((question) => question.target?.recordKey)).toEqual([firstId, secondId]);
    expect(subject.admissions).toHaveLength(1);
    expect(subject.writes).toEqual([]);
    expect(harness.snapshot().permissionDenials).toHaveLength(1);
  }),
);

it.effect('does not turn prepared target facts into authority over a changed set', () =>
  Effect.gen(function* changedTargetFacts() {
    let resolutions = 0;
    const subject = fixture(() => {
      resolutions += 1;
      return (resolutions === 1 ? [firstId, secondId] : [firstId]).map((recordKey) => ({ moduleKey, recordKey }));
    });
    const harness = yield* harnessFor(subject, canonicalGate().bound);
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-target-changed', idempotencyKey: 'bulk-target-changed' },
      }),
    );
    expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
    expect(subject.writes).toEqual([]);
  }),
);

it.effect('checks every record for NEEDS_APPROVAL but refuses bulk proposal and scalar mandate dispatch', () =>
  Effect.gen(function* noScalarApprovalFallback() {
    const subject = fixture();
    const gate = canonicalGate({ authority: { cells: [cell({ capability: capabilityKey, mode: 'propose' })] } });
    const harness = yield* harnessFor(subject, gate.bound);
    const request = {
      payload,
      principal,
      registration: subject.action,
      transport: { correlationId: 'bulk-needs-approval', idempotencyKey: 'bulk-needs-approval' },
    };
    const refusedRun = failureOf(yield* Effect.exit(harness.runtime.runAction(request)));
    expect(Schema.is(ActionPermissionDenied)(refusedRun) && refusedRun.code).toBe('action_approval_required');
    expect(gate.questions.map((question) => question.target?.recordKey)).toEqual([firstId, secondId]);
    const proposed = yield* Effect.exit(
      harness.runtime.runAction({
        ...request,
        successContract: 'result-or-proposal',
        transport: { ...request.transport, idempotencyKey: 'bulk-propose', intent: 'propose' },
      }),
    );
    expect(Schema.is(ActionPermissionCheckError)(failureOf(proposed))).toBe(true);
    const mandated = yield* Effect.exit(
      harness.runtime.runAction({
        ...request,
        payload: null,
        transport: { correlationId: 'bulk-mandate', mandateId: '00000000-0000-4000-8000-000000000123' },
      }),
    );
    expect(Schema.is(ActionPermissionCheckError)(failureOf(mandated))).toBe(true);
    expect(subject.writes).toEqual([]);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);

it.effect('a run grant for one record and a propose grant for another never admit a partial write', () =>
  Effect.gen(function* mixedModesAreNotUnioned() {
    const subject = fixture();
    const gate = canonicalGate({
      authority: {
        cells: [
          cell({ capability: capabilityKey, mode: 'run', selector: { _tag: 'targets', recordKeys: [firstId] } }),
          cell({ capability: capabilityKey, mode: 'propose', selector: { _tag: 'targets', recordKeys: [secondId] } }),
        ],
      },
    });
    const harness = yield* harnessFor(subject, gate.bound);
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-mixed-modes', idempotencyKey: 'bulk-mixed-modes' },
      }),
    );
    const denial = failureOf(exit);
    expect(Schema.is(ActionPermissionDenied)(denial) && denial.code).toBe('action_approval_required');
    expect(gate.questions.map((question) => [question.mode, question.target?.recordKey])).toEqual([
      ['run', firstId],
      ['run', secondId],
    ]);
    expect(subject.writes).toEqual([]);
    expect(subject.admissions).toEqual([]);
    expect(harness.snapshot().permissionDenials).toHaveLength(1);
  }),
);

it.effect('keeps the transaction I/O guard in place for every target and writes nothing on remote I/O', () =>
  Effect.gen(function* cannotCarryLeaseAcrossExternalCall() {
    const subject = fixture();
    const harness = yield* harnessFor(subject, canonicalGate({ guardedRecord: secondId }).bound);
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-guard', idempotencyKey: 'bulk-guard' },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(subject.writes).toEqual([]);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);

it.effect('preserves forward mandate execution for an exact singleton with APPROVE and independent Read RUN', () =>
  Effect.gen(function* approvedDispatchMode() {
    const read = readFor(moduleKey);
    const action = defineAction(
      {
        ...descriptor,
        accessFieldGroups: [],
        accessGoverningRead: defineActionGoverningRead(read),
        accessTargets: defineActionAccessTargets(allTargets),
      },
      (decoded) => Effect.succeed({ count: decoded.employeeIds.length }),
      services,
    );
    const owner = makeTestOperationOwner({ actions: [action], moduleId: moduleKey, reads: [read] });
    const gate = canonicalGate({
      authority: {
        cells: [
          cell({ capability: capabilityKey, mode: 'approve' }),
          cell({ capability: `${moduleKey}.record.read` }),
          cell({ capability: `${moduleKey}.record.read-salary` }),
        ],
      },
    });
    const { calls, dispatch: recording } = scalarDispatch({ employeeIds: [firstId] });
    const command = yield* resolveActionCommandV2({
      payload: { employeeIds: [firstId] },
      registration: action,
      scope: { ...principal, correlationId: 'single-approved' },
    });
    const dispatch: ActionMandateDispatch = {
      ...recording,
      prepare: (input) =>
        recording.prepare(input).pipe(
          Effect.map((prepared) => ({
            ...prepared,
            command: { capabilityKey: CapabilityKeySchema.make(capabilityKey), payload: command },
            commandDigest: Result.getOrThrow(freezeActionCommandV2(command)),
          })),
        ),
    };
    const harness = yield* makeActionTestHarness({
      accessDecision: gate.bound,
      mandateDispatch: dispatch,
      ownerRegistration: owner.ownerRegistration,
    });
    const result = yield* harness.runtime.runAction({
      payload: null,
      principal,
      registration: action,
      transport: { correlationId: 'single-approved', mandateId: '00000000-0000-4000-8000-000000000083' },
    });
    expect(result).toEqual({ count: 1 });
    expect(
      gate.questions
        .filter((question) => question.carrier.accessDeclaration?.kind === 'action')
        .map((question) => question.mode),
    ).toEqual(['approve', 'approve']);
    expect(
      gate.questions
        .filter((question) => question.carrier.accessDeclaration?.kind !== 'action')
        .map((question) => question.mode),
    ).toEqual(['run', 'run', 'run', 'run']);
    expect(calls).toEqual(['claim', 'commit']);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('never interprets a prepared scalar mandate as approval for a complete bulk payload', () =>
  Effect.gen(function* scalarMandateCannotApproveBulk() {
    const subject = fixture();
    const gate = canonicalGate();
    const { calls, dispatch } = scalarDispatch(payload);
    const harness = yield* makeActionTestHarness({
      accessDecision: gate.bound,
      mandateDispatch: dispatch,
      ownerRegistration: subject.owner.ownerRegistration,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: null,
        principal,
        registration: subject.action,
        transport: { correlationId: 'scalar-for-bulk', mandateId: '00000000-0000-4000-8000-000000000083' },
      }),
    );
    expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
    expect(calls).toEqual([]);
    expect(gate.questions).toEqual([]);
    expect(subject.admissions).toEqual([]);
    expect(subject.writes).toEqual([]);
    expect(harness.snapshot().invocations).toEqual([]);
  }),
);

it.effect('preserves the scalar proposal contract for an exact singleton target set', () =>
  Effect.gen(function* singletonProposalCompatibility() {
    const subject = fixture();
    const gate = canonicalGate({ authority: { cells: [cell({ capability: capabilityKey, mode: 'propose' })] } });
    const { dispatch, parks } = scalarDispatch({ employeeIds: [firstId] });
    const harness = yield* makeActionTestHarness({
      accessDecision: gate.bound,
      mandateDispatch: dispatch,
      ownerRegistration: subject.owner.ownerRegistration,
    });
    const result = yield* harness.runtime.runAction({
      payload: { employeeIds: [firstId] },
      principal,
      registration: subject.action,
      successContract: 'result-or-proposal',
      transport: { correlationId: 'single-set-proposal', idempotencyKey: 'single-set-proposal', intent: 'propose' },
    });
    expect(Schema.is(ActionProposalAcceptedSchema)(result)).toBe(true);
    expect(parks).toHaveLength(1);
    expect(parks[0]?.target).toBe(firstId);
    expect(parks[0]?.payload).toEqual({ employeeIds: [firstId] });
    expect(subject.writes).toEqual([]);
  }),
);

it.effect('checks every target in the owner overlay before the owner handler can write', () =>
  Effect.gen(function* allOwnerRules() {
    const subject = fixture();
    const checked: string[] = [];
    const harness = yield* makeActionTestHarness({
      accessDecision: canonicalGate().bound,
      onOwnerAuthorization: (input) => {
        checked.push(input.target?.recordKey ?? 'missing');
        return input.target?.recordKey === secondId ? 'denied' : 'allowed';
      },
      ownerRegistration: subject.owner.ownerRegistration,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-owner-denied', idempotencyKey: 'bulk-owner-denied' },
      }),
    );
    expect(Schema.is(ActionPermissionDenied)(failureOf(exit))).toBe(true);
    expect(checked).toEqual([firstId, secondId]);
    expect(subject.writes).toEqual([]);
    expect(harness.snapshot().permissionDenials).toHaveLength(1);
    expect(harness.snapshot().committed).toEqual([]);
  }),
);

it.effect('rechecks field groups on the second record and treats their unavailability as retryable', () =>
  Effect.gen(function* changedFieldAuthority() {
    const subject = fixture();
    const allowed = canonicalGate();
    const unavailable = canonicalGate({ failRecord: secondId });
    let held = false;
    const gate: BoundAccessGate = {
      ...allowed.bound,
      decide: (question, transaction) =>
        (held && question.carrier.accessDeclaration?.key === salaryKey ? unavailable : allowed).bound.decide(
          question,
          transaction,
        ),
    };
    const harness = yield* makeActionTestHarness({
      accessDecision: gate,
      lockAccessExecutionFence: () =>
        Effect.sync(() => {
          held = true;
        }),
      ownerRegistration: subject.owner.ownerRegistration,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload,
        principal,
        registration: subject.action,
        transport: { correlationId: 'bulk-field-unavailable', idempotencyKey: 'bulk-field-unavailable' },
      }),
    );
    expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
    expect(unavailable.questions.map((question) => question.target?.recordKey)).toEqual([firstId, secondId]);
    expect(harness.snapshot().permissionDenials).toEqual([]);
    expect(subject.writes).toEqual([]);
  }),
);
