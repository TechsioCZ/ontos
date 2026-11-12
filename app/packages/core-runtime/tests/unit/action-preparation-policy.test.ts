import { Context, Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeAccessDecisionService } from '../../src/access/enforcement/service.ts';
// Import the public barrel as well as running the native registered-owner lifecycle.
import { defineAction } from '../../src/index.ts';
import { ActionPolicyDenied } from '../../src/actions/errors.ts';
import type { ActionServiceFactory, ActionServicePreflight } from '../../src/actions/definition.ts';
import {
  defineMicroverticalPolicy,
  defineMicroverticalPreparationPolicy,
  denyPolicy,
} from '../../src/actions/policy.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { bindAccessGate } from '../../src/operations/access-gate.ts';
import {
  bindActionTestServices,
  makeActionPreparationProbe,
  makeActionTestHarness,
} from '../../src/testing/actions.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

const ownerKey = 'demo.preparation-policy';
const actionKey = `${ownerKey}.assign`;
const capabilityKey = `${ownerKey}.record.assign`;
const AssigneeIdSchema = Schema.String.pipe(Schema.brand('AssigneeId'));
const schema = Schema.Struct({ assigneeId: AssigneeIdSchema });
type Payload = typeof schema.Type;
const UnavailableContract = Schema.TaggedStruct('AssignmentUnavailable', { reason: Schema.String });
const Unavailable = Schema.TaggedError<typeof UnavailableContract.Type>()('AssignmentUnavailable', {
  reason: Schema.String,
});
class AssignablePrincipals extends Context.Service<
  AssignablePrincipals,
  { readonly check: (principalId: string) => Effect.Effect<boolean, typeof Unavailable.Type> }
>()('@app/core-runtime/tests/unit/action-preparation-policy.test/AssignablePrincipals') {}

const originalPolicy = defineMicroverticalPreparationPolicy<Payload, typeof ownerKey>({
  owningModuleKey: ownerKey,
  policyKey: `${ownerKey}.assignable.v1`,
});
const otherPolicy = defineMicroverticalPolicy<Payload, typeof ownerKey>({
  evaluate: () => Effect.void,
  owningModuleKey: ownerKey,
  policyKey: `${ownerKey}.foreign.v1`,
});
const descriptor = {
  accessDeclaration: {
    key: capabilityKey,
    kind: 'action',
    modes: ['run'],
    placement: { group: 'record', level: 'basic' },
    risk: 'routine',
    selectors: [],
  },
  accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${actionKey}.access.v1` },
  actionKey,
  auditProfile: 'sensitive',
  domainErrorSchema: Unavailable,
  domainEvents: {},
  entrypoint: defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'protected' },
    entrypointKey: actionKey,
    moduleKey: ownerKey,
    role: 'action',
  }),
  idempotency: 'required',
  legalEntityScope: 'optional',
  owningModuleKey: ownerKey,
  payloadSchema: schema,
  policies: [originalPolicy],
  resultSchema: Schema.String,
  schemaVersion: '1',
} as const;
const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:preparation-policy',
  authMethod: 'session',
  principalId: person,
  tenantId: tenant,
});
const services: ActionServiceFactory<Readonly<Record<string, never>>> = () => Effect.succeed(Object.freeze({}));
const unconsumedOwnerFactory: ActionServiceFactory<Readonly<Record<string, never>>> = () =>
  Effect.die('Observation must not consume the original owner factory');
const canonicalGate = (allowed = true) => {
  const spec = { cells: allowed ? [cell({ capability: capabilityKey })] : [] };
  const intent = { authorityFor: () => makeAuthority(spec).port };
  const ports = {
    candidates: { listCandidateIds: () => Effect.succeed([]) },
    check: makeCheck({ authority: spec }).port,
    decisionLog: { record: () => Effect.void },
    intent,
    principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
  };
  return bindAccessGate(
    makeAccessDecisionService({
      authorityFor: intent.authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
    }),
    ports,
  );
};
type Preflight = ActionServicePreflight<
  Payload,
  Readonly<Record<string, never>>,
  typeof Unavailable.Type,
  AssignablePrincipals
>;
const fixture = <Requirements>(
  prepareServices: ActionServicePreflight<
    Payload,
    Readonly<Record<string, never>>,
    typeof Unavailable.Type,
    Requirements
  >,
  allowed = true,
  explicit = true,
  bindServices = false,
) => {
  const writes: string[] = [];
  const registration = defineAction(
    descriptor,
    (payload) =>
      Effect.sync(() => {
        writes.push(payload.assigneeId);
        return payload.assigneeId;
      }),
    services,
    explicit ? { preparationPolicies: [originalPolicy], prepareServices } : { prepareServices },
  );
  const owner = makeTestOperationOwner({ actions: [registration], moduleId: ownerKey });
  return makeActionTestHarness({
    accessDecision: canonicalGate(allowed),
    applicationComposition: owner.applicationComposition,
    expectedDeployment: owner.expectedDeployment,
    ownerRegistration: owner.ownerRegistration,
    services: bindServices ? [bindActionTestServices(registration, Object.freeze({}))] : [],
  }).pipe(Effect.map((harness) => ({ ...harness, registration, writes })));
};
const checkAssignment: Preflight = (_payload, context) =>
  context
    .evaluatePolicy(originalPolicy, ({ action, payload, transport }) =>
      Effect.gen(function* checkAssignablePrincipal() {
        expect(action.actionKey).toBe(actionKey);
        expect('idempotencyKey' in transport).toBe(false);
        const directory = yield* AssignablePrincipals;
        if (!(yield* directory.check(payload.assigneeId))) {
          return yield* denyPolicy('assignee_not_assignable', 'The selected Principal cannot be assigned');
        }
        return payload.assigneeId;
      }),
    )
    .pipe(
      Effect.tap((resolvedAssignee) =>
        Effect.sync(() => {
          expect(resolvedAssignee).toBe('selected');
        }),
      ),
      Effect.as(services),
    );
const request = {
  payload: { assigneeId: AssigneeIdSchema.make('selected') },
  principal,
  transport: { correlationId: 'assignment', idempotencyKey: 'assignment' },
};
const noObservedFactory = () =>
  Option.none<ActionServiceFactory<Readonly<Record<string, never>>, AssignablePrincipals>>();

it.effect('publishes before normal factory consumption, once, without changing the required services', () =>
  Effect.gen(function* preparationProbeBeforeConsumption() {
    let readFactory = noObservedFactory;
    let preparations = 0;
    let consumptions = 0;
    const original: ActionServiceFactory<Readonly<Record<string, never>>, AssignablePrincipals> = () =>
      Effect.gen(function* consumeOriginalPreparation() {
        expect(Option.getOrThrow(readFactory())).toBe(original);
        const directory = yield* AssignablePrincipals;
        expect(yield* directory.check('selected').pipe(Effect.orDie)).toBe(true);
        consumptions += 1;
        return Object.freeze({});
      });
    const subject = yield* fixture((_payload, context) =>
      context
        .evaluatePolicy(originalPolicy, () => Effect.void)
        .pipe(
          Effect.map(() => {
            preparations += 1;
            return original;
          }),
        ),
    );
    const probe = makeActionPreparationProbe(subject.registration);
    readFactory = probe.snapshot;
    const run = subject.runtime
      .runAction(probe.input(request))
      .pipe(Effect.provideService(AssignablePrincipals, { check: () => Effect.succeed(true) }));
    expect(yield* run).toBe('selected');
    expect((yield* Effect.flip(run))._tag).toBe('ActionAlreadyCommitted');
    expect(Option.getOrThrow(probe.snapshot())).toBe(original);
    expect(preparations).toBe(1);
    expect(consumptions).toBe(1);
  }),
);

it.effect('does not publish a different original registration through a transferred probe input', () =>
  Effect.gen(function* preparationProbeRegistrationIdentity() {
    const first = yield* fixture((_payload, context) =>
      context.evaluatePolicy(originalPolicy, () => Effect.void).pipe(Effect.as(services)),
    );
    const second = yield* fixture((_payload, context) =>
      context.evaluatePolicy(originalPolicy, () => Effect.void).pipe(Effect.as(services)),
    );
    const probe = makeActionPreparationProbe(first.registration);
    const result = yield* second.runtime.runAction({ ...probe.input(request), registration: second.registration });
    expect(result).toBe('selected');
    expect(Option.isNone(probe.snapshot())).toBe(true);
  }),
);

it.effect('observes the original owner factory without consuming it when test services are bound', () =>
  Effect.gen(function* originalFactoryObservationOnly() {
    let preparations = 0;
    const subject = yield* fixture(
      (_payload, context) =>
        context
          .evaluatePolicy(originalPolicy, () => Effect.void)
          .pipe(
            Effect.map(() => {
              preparations += 1;
              return unconsumedOwnerFactory;
            }),
          ),
      true,
      true,
      true,
    );
    const probe = makeActionPreparationProbe(subject.registration);
    expect(yield* subject.runtime.runAction(probe.input(request))).toBe('selected');
    expect(Option.getOrThrow(probe.snapshot())).toBe(unconsumedOwnerFactory);
    expect(preparations).toBe(1);
    expect(subject.writes).toEqual(['selected']);
  }),
);

it.effect('evaluates genuine required ports once outside owner SQL and records the exact allowed Policy', () =>
  Effect.gen(function* allowedPreparationPolicy() {
    const subject = yield* fixture(checkAssignment);
    const probe = makeActionPreparationProbe(subject.registration);
    let checks = 0;
    expect(Option.isNone(probe.snapshot())).toBe(true);
    const run = subject.runtime.runAction(probe.input(request));
    const result = yield* run.pipe(
      Effect.provideService(AssignablePrincipals, {
        check: () =>
          Effect.sync(() => {
            checks += 1;
            expect(subject.snapshot().transactionCount).toBe(0);
            return true;
          }),
      }),
    );
    expect(result).toBe('selected');
    expect(checks).toBe(1);
    expect(Option.getOrThrow(probe.snapshot())).toBe(services);
    expect(subject.writes).toEqual(['selected']);
    expect(subject.snapshot().committed[0]?.allowedPolicies).toEqual([
      { owningModuleKey: ownerKey, policyKey: originalPolicy.policyKey, scope: 'microvertical' },
    ]);
  }),
);

it.effect('persists one normalized Policy denial and replays it without calling the directory again', () =>
  Effect.gen(function* deniedPreparationPolicy() {
    const subject = yield* fixture(checkAssignment);
    const probe = makeActionPreparationProbe(subject.registration);
    let checks = 0;
    const run = subject.runtime.runAction(probe.input(request)).pipe(
      Effect.provideService(AssignablePrincipals, {
        check: () =>
          Effect.sync(() => {
            checks += 1;
            return false;
          }),
      }),
    );
    const first = yield* Effect.flip(run);
    expect(subject.snapshot().transactionCount).toBe(0);
    const retry = yield* Effect.flip(run);
    expect(Predicate.isTagged(first, 'ActionPolicyDenied')).toBe(true);
    expect(Predicate.isTagged(retry, 'ActionPolicyDenied')).toBe(true);
    expect(checks).toBe(1);
    expect(Option.isNone(probe.snapshot())).toBe(true);
    expect(subject.writes).toEqual([]);
    // Terminal retry may read its invocation in a short SQL transaction; it acquires no owner services.
    expect(subject.snapshot().committed).toEqual([]);
    expect(subject.snapshot().policyDenials).toHaveLength(1);
    expect(subject.snapshot().policyDenials[0]).toMatchObject({
      actionKey,
      policy: { owningModuleKey: ownerKey, policyKey: originalPolicy.policyKey, scope: 'microvertical' },
      reasonCode: 'assignee_not_assignable',
    });
  }),
);

it.effect('admits the ordinary Core gate before any effectful preparation', () =>
  Effect.gen(function* deniedCoreGate() {
    const subject = yield* fixture(() => Effect.die('Preparation must not run'), false);
    const probe = makeActionPreparationProbe(subject.registration);
    const failure = yield* Effect.flip(subject.runtime.runAction(probe.input(request)));
    expect(Option.isNone(probe.snapshot())).toBe(true);
    expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
    expect(subject.snapshot().policyDenials).toEqual([]);
    expect(subject.writes).toEqual([]);
  }),
);

it.effect('keeps directory unavailability typed and retryable, not a terminal Policy denial', () =>
  Effect.gen(function* unavailablePreparationPolicy() {
    const subject = yield* fixture(checkAssignment);
    const probe = makeActionPreparationProbe(subject.registration);
    let checks = 0;
    const run = subject.runtime.runAction(probe.input(request)).pipe(
      Effect.provideService(AssignablePrincipals, {
        check: () =>
          Effect.suspend(() => {
            checks += 1;
            return Effect.fail(new Unavailable({ reason: 'offline' }));
          }),
      }),
    );
    expect((yield* Effect.flip(run))._tag).toBe('AssignmentUnavailable');
    expect((yield* Effect.flip(run))._tag).toBe('AssignmentUnavailable');
    expect(checks).toBe(2);
    expect(Option.isNone(probe.snapshot())).toBe(true);
    expect(subject.snapshot().policyDenials).toEqual([]);
    expect(subject.writes).toEqual([]);
  }),
);

it.effect('bound transaction services still run the genuine preparation Policy and retain its allowed evidence', () =>
  Effect.gen(function* boundServicesPreservePolicy() {
    const subject = yield* fixture(checkAssignment, true, true, true);
    const probe = makeActionPreparationProbe(subject.registration);
    let checks = 0;
    const result = yield* subject.runtime.runAction(probe.input(request)).pipe(
      Effect.provideService(AssignablePrincipals, {
        check: () =>
          Effect.sync(() => {
            checks += 1;
            expect(subject.snapshot().transactionCount).toBe(0);
            return true;
          }),
      }),
    );
    expect(result).toBe('selected');
    expect(checks).toBe(1);
    // Bound services replace consumption only. The observed result is the original factory.
    expect(Option.getOrThrow(probe.snapshot())).toBe(services);
    expect(subject.snapshot().committed[0]?.allowedPolicies).toEqual([
      { owningModuleKey: ownerKey, policyKey: originalPolicy.policyKey, scope: 'microvertical' },
    ]);
  }),
);

it.effect('bound transaction services cannot skip a terminal preparation denial or its idempotent audit', () =>
  Effect.gen(function* boundServicesPreserveDenial() {
    const subject = yield* fixture(checkAssignment, true, true, true);
    let checks = 0;
    const run = subject.runtime.runAction({ ...request, registration: subject.registration }).pipe(
      Effect.provideService(AssignablePrincipals, {
        check: () =>
          Effect.sync(() => {
            checks += 1;
            return false;
          }),
      }),
    );
    expect((yield* Effect.flip(run))._tag).toBe('ActionPolicyDenied');
    expect((yield* Effect.flip(run))._tag).toBe('ActionPolicyDenied');
    expect(checks).toBe(1);
    expect(subject.writes).toEqual([]);
    expect(subject.snapshot().committed).toEqual([]);
    expect(subject.snapshot().policyDenials).toHaveLength(1);
    expect(subject.snapshot().policyDenials[0]?.policy.policyKey).toBe(originalPolicy.policyKey);
  }),
);

it.effect('bound transaction services preserve genuine preparation unavailability and allow a later retry', () =>
  Effect.gen(function* boundServicesPreserveRetry() {
    const subject = yield* fixture(checkAssignment, true, true, true);
    const probe = makeActionPreparationProbe(subject.registration);
    let checks = 0;
    const run = subject.runtime.runAction(probe.input(request)).pipe(
      Effect.provideService(AssignablePrincipals, {
        check: () =>
          Effect.suspend(() => {
            checks += 1;
            return checks === 1 ? Effect.fail(new Unavailable({ reason: 'offline' })) : Effect.succeed(true);
          }),
      }),
    );
    expect((yield* Effect.flip(run))._tag).toBe('AssignmentUnavailable');
    expect(Option.isNone(probe.snapshot())).toBe(true);
    expect(subject.writes).toEqual([]);
    expect(subject.snapshot().transactionCount).toBe(0);
    expect(yield* run).toBe('selected');
    expect(Option.getOrThrow(probe.snapshot())).toBe(services);
    expect(checks).toBe(2);
    expect(subject.snapshot().policyDenials).toEqual([]);
    expect(subject.snapshot().committed).toHaveLength(1);
  }),
);

for (const violation of [
  'omitted',
  'duplicate',
  'copied',
  'undeclared',
  'caught-denial',
  'uncounted-core-denial',
  'defect',
] as const) {
  it.effect(`fails closed for a ${violation} preparation Policy without owner writes`, () =>
    Effect.gen(function* invalidPreparationPolicy() {
      const subject = yield* fixture((_payload, context) =>
        Effect.gen(function* violatePolicyContract() {
          if (violation === 'omitted') {
            return services;
          }
          let selected = originalPolicy;
          if (violation === 'copied') {
            selected = { ...originalPolicy };
          }
          if (violation === 'undeclared') {
            selected = otherPolicy;
          }
          yield* context
            .evaluatePolicy(selected, () => {
              if (violation === 'caught-denial') {
                return Effect.fail(denyPolicy('blocked', 'Blocked'));
              }
              if (violation === 'uncounted-core-denial') {
                return Effect.fail(
                  new ActionPolicyDenied({
                    code: 'action_policy_denied',
                    policyReasonCode: 'not-a-policy-verdict',
                    reason: 'An owner-created Core error cannot stand in for a Policy verdict',
                  }),
                );
              }
              if (violation === 'defect') {
                return Effect.die('secret defect');
              }
              return Effect.void;
            })
            .pipe(Effect.ignore);
          if (violation === 'duplicate') {
            yield* context.evaluatePolicy(selected, () => Effect.void).pipe(Effect.ignore);
          }
          return services;
        }),
      );
      const probe = makeActionPreparationProbe(subject.registration);
      const failure = yield* Effect.flip(subject.runtime.runAction(probe.input(request)));
      expect(Option.isNone(probe.snapshot())).toBe(true);
      expect(failure._tag).toBe(violation === 'caught-denial' ? 'ActionPolicyDenied' : 'ActionPolicyEvaluationError');
      expect(subject.writes).toEqual([]);
      expect(subject.snapshot().committed).toEqual([]);
    }),
  );
}

it('rejects copied, foreign and duplicate preparation Policy registrations', () => {
  for (const preparationPolicies of [[], [{ ...originalPolicy }], [otherPolicy], [originalPolicy, originalPolicy]]) {
    expect(() =>
      defineAction(descriptor, () => Effect.succeed('ok'), services, {
        preparationPolicies,
        prepareServices: () => Effect.succeed(services),
      }),
    ).toThrow();
  }
});

it('requires registered preparation for an intrinsically effectful Policy', () => {
  expect(() => defineAction(descriptor, () => Effect.succeed('ok'))).toThrow();
  expect(() => defineAction(descriptor, () => Effect.succeed('ok'), services)).toThrow();
});

it.effect('accounts for an intrinsic preparation Policy even without a second Policy list', () =>
  Effect.gen(function* intrinsicPreparationPolicy() {
    const subject = yield* fixture(checkAssignment, true, false);
    const result = yield* subject.runtime
      .runAction({ ...request, registration: subject.registration })
      .pipe(Effect.provideService(AssignablePrincipals, { check: () => Effect.succeed(true) }));
    expect(result).toBe('selected');
    expect(subject.snapshot().committed[0]?.allowedPolicies).toEqual([
      { owningModuleKey: ownerKey, policyKey: originalPolicy.policyKey, scope: 'microvertical' },
    ]);
  }),
);
