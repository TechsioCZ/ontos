import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionPorts } from '@app/core-runtime/access/enforcement';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ingestProviderObservationAction } from '../../src/actions/ingest-provider-observation.action.ts';
import { reconcileProviderEvidenceWorker } from '../../src/workers/reconcile-provider-evidence.worker.ts';
import { communicationsManifest } from '../../vertical.manifest.ts';

/**
 * [T2-09] Who may hand Communications a provider observation: ONLY the registered Messaging Adapter workload. The Action
 * declares `accessWorkload` alone, so no human capability, role or agent can ever run it, and Core's real access decision service
 * decides it from the workload registry (scripted here, as Core's registry answers it under row-level security).
 */
const ADAPTER = 'communications.core.messaging-adapter';
const PRINCIPAL = '77777777-7777-4777-8777-0000000000e1';
const TENANT = '11111111-1111-4111-8111-0000000000e1';
const OTHER_TENANT = '22222222-2222-4222-8222-0000000000e1';

const principalIn = (tenantId: string): OperationalScope => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '99999999-9999-4999-8999-0000000000e1',
    authContextRef: 'api-key:fixture-messaging-adapter',
    authMethod: 'api_key',
    principalId: PRINCIPAL,
    tenantId,
  }),
  correlationId: 'provider-observation-ingest-access',
});

const neverAsked = (port: string) => Effect.die(`the workload path asked ${port}`);

const gateWith = (kind: 'human' | 'integration', registry: Readonly<Record<string, readonly string[]>>) => {
  const ports: AccessDecisionPorts = {
    authorityFor: () => ({
      readCells: () => neverAsked('the grant cells'),
      readCompanyOwnership: () => neverAsked('company ownership'),
      readConnection: () => neverAsked('a connection'),
      readScope: () => neverAsked('the scope'),
      readTeamIds: () => neverAsked('the teams'),
    }),
    check: { checkBulk: () => neverAsked('the grant engine') },
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([]) },
    principalKinds: { readKind: () => Effect.succeed(Option.some(kind)) },
    workloadBindings: {
      readWorkloadAuthority: ({ principalId, tenantId }) =>
        Effect.succeed({
          activeCompanyIds: new Set(),
          workloadKeys: new Set(principalId === PRINCIPAL ? (registry[tenantId] ?? []) : []),
        }),
    },
  };
  const service = makeAccessDecisionService(ports);
  return (scope: OperationalScope) =>
    service.decide({
      carrier: ingestProviderObservationAction.descriptor,
      legalEntityScope: ingestProviderObservationAction.descriptor.legalEntityScope,
      now: new Date('2026-11-25T12:00:00.000Z'),
      scope,
    });
};

describe('the provider observation ingest admits only the registered Messaging Adapter workload (T2-09)', () => {
  it('declares a workload carrier alone, Tenant-wide, and no human capability', () => {
    const { descriptor } = ingestProviderObservationAction;
    expect(descriptor.accessWorkload?.workloads).toEqual([ADAPTER]);
    expect(descriptor.accessDeclaration).toBeUndefined();
    expect(descriptor.legalEntityScope).toBe('forbidden');
    expect(descriptor.idempotency).toBe('required');
    expect(communicationsManifest.publicSurface.actions.map((action) => action.descriptor.actionKey)).toContain(
      'communications.core.ingest-provider-observation',
    );
  });

  it.effect('admits an integration principal registered as the adapter in its Tenant', () =>
    Effect.gen(function* admitted() {
      const decision = yield* gateWith('integration', { [TENANT]: [ADAPTER] })(principalIn(TENANT));
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    }),
  );

  it.effect(
    'refuses it in a Tenant that registered no adapter, and when it is registered as another workload only',
    () =>
      Effect.gen(function* unbound() {
        const gate = gateWith('integration', {
          [OTHER_TENANT]: ['communications.core.request-source'],
          [TENANT]: [ADAPTER],
        });
        expect((yield* gate(principalIn(OTHER_TENANT))).reasons.map(({ code }) => code)).toEqual([
          'deny.workload_unbound',
        ]);
        expect((yield* gate(principalIn(OTHER_TENANT))).outcome).toBe('DENIED');
      }),
  );

  it.effect('refuses a human, however it is granted: the workload path never admits a person', () =>
    Effect.gen(function* human() {
      const decision = yield* gateWith('human', { [TENANT]: [ADAPTER] })(principalIn(TENANT));
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_only']);
    }),
  );
});

describe('the reconciliation entry is the owner worker of the recorded topic (no new queue or scheduler)', () => {
  it('consumes only the owner-local topic the ingest Action produces, tenant-wide', () => {
    const { descriptor } = reconcileProviderEvidenceWorker;
    expect(descriptor.workerKey).toBe('communications.core.reconcile-provider-evidence');
    expect(descriptor.topic).toBe('communications.core.provider-observation-recorded.v1');
    expect(descriptor.producerModuleKey).toBe('communications.core');
    expect(descriptor.consumerModuleKey).toBe('communications.core');
    expect(descriptor.legalEntityScope).toBe('forbidden');
  });
});
