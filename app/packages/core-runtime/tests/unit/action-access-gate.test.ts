import { Cause, Effect, Exit, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessPrincipalKind, AccessPrincipalKinds } from '../../src/access/enforcement/actor.ts';
import type { AccessDecisionLogWriter } from '../../src/access/enforcement/decision-log.ts';
import type { AccessWorkloadBindings } from '../../src/access/enforcement/workload-port.ts';
import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
import { LegalEntityIdSchema } from '../../src/access/ids.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionPermissionCheckError, ActionPermissionDenied } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

/** Module-operation admission refuses a non-Core Action with no bound owner registration. */
const shellOwner = makeTestOperationOwner({ moduleId: 'core.shell' }).ownerRegistration;

/**
 * L04's required negative controls, proved through the real Action runner: the gate decides, and the
 * runner turns its answer into exactly the failure the generated HTTP runners map (403 for a denial
 * and for an approval requirement, 503 for an unanswerable engine). No handler runs in any of them.
 */

const legalEntityId = LegalEntityIdSchema.make('00000000-0000-4000-8000-000000000080');
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:access-gate-fixture',
  authMethod: 'session',
  legalEntityId,
  principalId: person,
  tenantId: tenant,
});

const DECLARED = 'core.shell.fixture.change';
const RECORD_SCOPED = 'core.shell.fixture.reassign';
const WORKLOAD = 'core.shell.fixture.provision';

const entrypointFor = (entrypointKey: string) =>
  defineSystemModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey,
    moduleKey: 'core.shell',
    role: 'action',
  });

const declarationOf = (key: string, overrides: Partial<AccessDeclarationInput> = {}): AccessDeclarationInput => ({
  key,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'fixtures', level: 'basic' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

/** The descriptor every fixture shares; only its carrier and key differ. */
const fixtureDescriptor = (actionKey: string) => ({
  accessEvidencePolicy: { captureMode: 'metadata_only' as const, policyKey: `${actionKey}.access.v1` },
  actionKey,
  auditProfile: 'standard' as const,
  domainErrorSchema: Schema.Never,
  domainEvents: {},
  entrypoint: entrypointFor(actionKey),
  idempotency: 'required' as const,
  legalEntityScope: 'optional' as const,
  owningModuleKey: 'core.shell',
  payloadSchema: Schema.Struct({ amount: Schema.Finite }),
  policies: [],
  resultSchema: Schema.Struct({ total: Schema.Finite }),
  schemaVersion: '1',
});

/** The fixtures own no services and require none, so the runner's signature stays exact. */
const noServices = () => Effect.succeed(Object.freeze({}));

/** A protected Action whose declaration is scope-wide: the gate answers it directly (Q2). */
const declaredAction = defineAction(
  { ...fixtureDescriptor(DECLARED), accessDeclaration: declarationOf(DECLARED) },
  (payload) => Effect.succeed({ total: payload.amount }),
  noServices,
);
/** A protected Action whose declaration is record-scoped and declares no target resolver (O9, Q2). */
const recordScopedAction = defineAction(
  { ...fixtureDescriptor(RECORD_SCOPED), accessDeclaration: declarationOf(RECORD_SCOPED, { selectors: ['assigned'] }) },
  (payload) => Effect.succeed({ total: payload.amount }),
  noServices,
);
/** A workload Action: only trusted machines may run it, so a person is refused (O29, O59). */
const workloadAction = defineAction(
  {
    ...fixtureDescriptor(WORKLOAD),
    accessWorkload: { reason: 'Trusted machine provisioning only', workloads: ['core.machine-provisioner'] },
  },
  (payload) => Effect.succeed({ total: payload.amount }),
  noServices,
);

const kindSource = (kind: AccessPrincipalKind): AccessPrincipalKinds => ({
  readKind: () => Effect.succeed(Option.some(kind)),
});

const decisionLog = (): AccessDecisionLogWriter => ({ record: () => Effect.void });

interface SeamOptions {
  readonly authority?: AuthoritySpec;
  readonly engineFailure?: boolean;
  readonly kind?: AccessPrincipalKind;
  /** The active workload keys the registry answers for the actor; default none (O73). */
  readonly workloadKeys?: readonly string[];
}

/** The real seam with faked ports: the production service, minus SpiceDB and PostgreSQL. */
const boundGate = (options: SeamOptions = {}): BoundAccessGate => {
  const authoritySpec: AuthoritySpec = options.authority ?? { cells: [cell({ capability: DECLARED })] };
  const authority = makeAuthority(authoritySpec);
  const check =
    options.engineFailure === true
      ? makeCheck({ authority: authoritySpec, failure: true })
      : makeCheck({ authority: authoritySpec });
  const workloadBindings: AccessWorkloadBindings = {
    readActiveWorkloadKeys: () => Effect.succeed(new Set(options.workloadKeys)),
    readCompanyDeclaration: () => Effect.succeed({ activeCompanyIds: new Set(), pinned: false }),
  };
  const ports = {
    candidates: { listCandidateIds: () => Effect.succeed([legalEntityId]) },
    check: check.port,
    decisionLog: decisionLog(),
    intent: { authorityFor: () => authority.port },
    principalKinds: kindSource(options.kind ?? 'human'),
    workloadBindings,
  } satisfies Parameters<typeof bindAccessGate>[1];
  const seam = makeAccessDecisionService({
    authorityFor: () => authority.port,
    check: ports.check,
    decisionLog: ports.decisionLog,
    legalEntities: ports.candidates,
    principalKinds: ports.principalKinds,
    workloadBindings,
  });
  return bindAccessGate(seam, ports);
};

type Fixture = typeof declaredAction;

/** One protected run, answered as the exit of the runner plus what it recorded. */
const runFixture = <Registration extends Fixture>(input: {
  readonly accessDecision: BoundAccessGate;
  readonly registration: Registration;
}) =>
  Effect.gen(function* runProtectedFixture() {
    const harness = yield* makeActionTestHarness({
      accessDecision: input.accessDecision,
      ownerRegistration: shellOwner,
    });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration: input.registration,
        transport: { correlationId: 'access-gate-fixture', idempotencyKey: 'access-gate-fixture-1' },
      }),
    );
    return { exit, snapshot: harness.snapshot() };
  });

/** The typed failure of a refused run: the runner's failure is always a fail reason, never a defect. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): object => {
  if (Exit.isSuccess(exit)) {
    throw new Error('The fixture expected the runner to refuse this call');
  }
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason) && Predicate.isObject(reason.error)) {
      return reason.error;
    }
  }
  throw new Error('The fixture expected a typed refusal, not a defect');
};

/** The one refusal the generated HTTP runners map to 403 for both codes (O67-Q9). */
const denialOf = (exit: Exit.Exit<unknown, unknown>): ActionPermissionDenied => {
  const failure = failureOf(exit);
  if (!Schema.is(ActionPermissionDenied)(failure)) {
    throw new Error('The fixture expected an ActionPermissionDenied');
  }
  return failure;
};

it.effect('refuses a workload principal on a declaration with 403 and records the denial', () =>
  Effect.gen(function* refusesWorkloadOnDeclaration() {
    const accessDecision = boundGate({ kind: 'service' });
    const { exit, snapshot } = yield* runFixture({ accessDecision, registration: declaredAction });
    const failure = denialOf(exit);

    expect(failure.code).toBe('action_permission_denied');
    expect(failure.reasons).toEqual(['deny.workload_forbidden']);
    expect(snapshot.permissionDenials.length).toBe(1);
    expect(snapshot.stages).not.toContain('handler_executed');
  }),
);

it.effect('refuses an agent on a declaration with deny.agent_forbidden (O67-Q5)', () =>
  Effect.gen(function* refusesAgent() {
    const accessDecision = boundGate({ kind: 'agent' });
    const { exit, snapshot } = yield* runFixture({ accessDecision, registration: declaredAction });
    const failure = denialOf(exit);

    expect(failure.reasons).toEqual(['deny.agent_forbidden']);
    expect(snapshot.stages).not.toContain('handler_executed');
  }),
);

it.effect('refuses a human on a workload carrier with 403 and never reaches the handler', () =>
  Effect.gen(function* refusesHumanOnWorkload() {
    const accessDecision = boundGate({ kind: 'human' });
    const { exit, snapshot } = yield* runFixture({ accessDecision, registration: workloadAction });
    const failure = denialOf(exit);

    expect(failure.reasons).toEqual(['deny.workload_only']);
    expect(snapshot.permissionDenials.length).toBe(1);
    expect(snapshot.stages).not.toContain('handler_executed');
  }),
);

it.effect('refuses a record-scoped declaration with no target with 403 and names the missing target', () =>
  Effect.gen(function* refusesSelectorWithoutTarget() {
    const accessDecision = boundGate({
      authority: { cells: [cell({ capability: RECORD_SCOPED, selector: { _tag: 'assigned' } })] },
    });
    const { exit, snapshot } = yield* runFixture({ accessDecision, registration: recordScopedAction });
    const failure = denialOf(exit);

    expect(failure.reasons).toEqual(['deny.target_required']);
    expect(snapshot.permissionDenials.length).toBe(1);
    expect(snapshot.stages).not.toContain('handler_executed');
  }),
);

it.effect('answers a dead engine with a retryable 503 and records no denial', () =>
  Effect.gen(function* answersDeadEngineWith503() {
    const accessDecision = boundGate({ engineFailure: true });
    const { exit, snapshot } = yield* runFixture({ accessDecision, registration: declaredAction });

    expect(Exit.isFailure(exit)).toBe(true);
    expect(Schema.is(ActionPermissionCheckError)(failureOf(exit))).toBe(true);
    expect(snapshot.permissionDenials).toEqual([]);
    expect(snapshot.stages).not.toContain('handler_executed');
  }),
);

it.effect('answers an approval requirement with action_approval_required and executes nothing (O67-Q9)', () =>
  Effect.gen(function* answersApprovalRequired() {
    const accessDecision = boundGate({
      authority: { cells: [cell({ capability: DECLARED, mode: 'propose' })] },
    });
    const { exit, snapshot } = yield* runFixture({ accessDecision, registration: declaredAction });
    const failure = denialOf(exit);

    expect(failure.code).toBe('action_approval_required');
    expect(snapshot.permissionDenials.length).toBe(1);
    expect(snapshot.stages).not.toContain('handler_executed');
  }),
);
