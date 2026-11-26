import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionPorts } from '@app/core-runtime/access/enforcement';
import {
  RegisteredGatewayWorkloadSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { bindPreVerificationSubjectAction } from '../../src/actions/bind-pre-verification-subject.action.ts';

/**
 * #1406: the admission of the Portal Auth source worker -> Privacy bind hop. Commerce Customer Context's source worker binds the
 * pre-verification subject through the public `bind-pre-verification-subject` Action as the registered workload
 * `privacy.core.pre-verification-subject-source`, naming the declaration `privacy.core.pre-verification-subject.bind`, from its
 * own Outbox delivery, before it submits the Communication Request.
 *
 * What is REAL: Core's access decision service over the Action's own declared carrier, with a context sealed the way the Shell
 * seals that worker's delivery. The workload registry is the one port scripted here: it answers the active workload keys a
 * principal holds in ONE Tenant, as Core's registry does under row-level security. Every identifier is FICTIONAL.
 */

const REVISION = 'd'.repeat(64);
const BIND_SOURCE = 'privacy.core.pre-verification-subject-source';
const WORKER_PRINCIPAL = '77777777-7777-4777-8777-0000000000e1';
const TENANT = '11111111-1111-4111-8111-0000000000e1';
const OTHER_TENANT = '22222222-2222-4222-8222-0000000000e1';

const decodeWorkload = Schema.decodeUnknownSync(RegisteredGatewayWorkloadSchema);

/** The worker principal of `tenantId`, sealed as the registered source worker of commerce.customer-context. */
const workerIn = (
  tenantId: string,
  overrides: { readonly declarationKey?: string; readonly workloadKey?: string } = {},
): OperationalScope =>
  trustVerifiedGatewayPrincipalContext(
    {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authContextRef: 'job:commerce.customer-context.submit-portal-auth-communication-request:run:1',
        authMethod: 'system',
        principalId: WORKER_PRINCIPAL,
        tenantId,
      }),
      correlationId: 'pre-verification-bind-worker-admission',
    },
    REVISION,
    undefined,
    undefined,
    decodeWorkload({
      admissionInvocationId: '60000000-0000-4000-8000-0000000000e2',
      bindingIncarnation: '60000000-0000-4000-8000-0000000000e3',
      claimId: 'fixture-claim',
      declarationKey: 'privacy.core.pre-verification-subject.bind',
      entrypointKey: 'privacy.core.bind-pre-verification-subject',
      jobKey: 'commerce.customer-context.submit-portal-auth-communication-request',
      legalEntityScope: 'optional',
      originalOwnerBindingIncarnation: '60000000-0000-4000-8000-0000000000e6',
      originalPrincipalId: '40000000-0000-4000-8000-0000000000e2',
      originalWorkloadBindingIncarnation: '60000000-0000-4000-8000-0000000000e5',
      originalWorkloadKey: 'fixture.source-admit',
      runReference: '60000000-0000-4000-8000-0000000000e2',
      schemaVersion: '1',
      sourceAppId: 'commerce-customer-context',
      sourceBuildMarker: 'fixture-build',
      sourceMode: 'worker',
      workerKey: 'commerce.customer-context.submit-portal-auth-communication-request',
      workerModuleKey: 'commerce.customer-context',
      workloadKey: BIND_SOURCE,
      ...overrides,
    }),
  );

/** No workload decision may reach the grant engine or the human scope reads: each port fails the test if it is asked. */
const neverAsked = (port: string) => Effect.die(`the workload path asked ${port}`);

/** Core's real access decision service; the registry holds, per Tenant, the workload keys of the worker principal. */
const gateWith = (registry: Readonly<Record<string, readonly string[]>>) => {
  const ports: AccessDecisionPorts = {
    authorityFor: () => ({
      readCells: () => neverAsked('the grant cells'),
      readConnection: () => neverAsked('a connection'),
      readScope: () => neverAsked('the scope'),
      readTeamIds: () => neverAsked('the teams'),
    }),
    check: { checkBulk: () => neverAsked('the grant engine') },
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([]) },
    principalKinds: { readKind: () => Effect.succeed(Option.some('system')) },
    workloadBindings: {
      readActiveWorkloadKeys: ({ principalId, tenantId }) =>
        Effect.succeed(new Set(principalId === WORKER_PRINCIPAL ? (registry[tenantId] ?? []) : [])),
    },
  };
  const service = makeAccessDecisionService(ports);
  return (scope: OperationalScope) =>
    service.decide({
      carrier: bindPreVerificationSubjectAction.descriptor,
      legalEntityScope: bindPreVerificationSubjectAction.descriptor.legalEntityScope,
      now: new Date('2026-11-22T12:00:00.000Z'),
      scope,
    });
};

describe('The Portal Auth source worker -> Privacy pre-verification bind admission (#1406)', () => {
  it.effect('admits the source worker registered as the pre-verification bind workload in its Tenant', () =>
    Effect.gen(function* admitted() {
      const decision = yield* gateWith({ [TENANT]: [BIND_SOURCE] })(workerIn(TENANT));
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    }),
  );

  it.effect('refuses the worker in a Tenant that registered no bind workload for it', () =>
    Effect.gen(function* otherTenant() {
      const decision = yield* gateWith({ [TENANT]: [BIND_SOURCE] })(workerIn(OTHER_TENANT));
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
    }),
  );

  it.effect('refuses a principal registered only as another workload', () =>
    Effect.gen(function* otherRegistration() {
      const decision = yield* gateWith({ [TENANT]: ['privacy.core.source-processing-check'] })(workerIn(TENANT));
      expect(decision.outcome).toBe('DENIED');
    }),
  );

  it.effect('refuses an assertion naming another workload or another declaration, however the registry is bound', () =>
    Effect.gen(function* otherAssertion() {
      const gate = gateWith({ [TENANT]: [BIND_SOURCE, 'privacy.core.source-processing-check'] });
      const otherWorkload = yield* gate(workerIn(TENANT, { workloadKey: 'privacy.core.source-processing-check' }));
      expect(otherWorkload).toMatchObject({ outcome: 'DENIED', reasons: [{ code: 'deny.workload_unbound' }] });
      const otherDeclaration = yield* gate(
        workerIn(TENANT, { declarationKey: 'privacy.core.bind-pre-verification-subject' }),
      );
      expect(otherDeclaration).toMatchObject({ outcome: 'DENIED', reasons: [{ code: 'deny.workload_unbound' }] });
    }),
  );
});
