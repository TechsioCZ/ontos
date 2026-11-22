import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionPorts } from '@app/core-runtime/access/enforcement';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationRequestSourceMismatch } from '../../shared/communication-intake-errors.ts';
import { submitCommunicationRequestAction } from '../../src/actions/submit-communication-request.action.ts';
import { communicationRequest, originalRecipient } from '../support/intake-fixtures.ts';
import { decided, intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';
import { fixtureType } from '../unit/support/catalog-fixtures.ts';
import { asSourceWorker } from '../support/source-worker-principal.ts';
import type { SourceWorkerOverrides } from '../support/source-worker-principal.ts';

/**
 * #1406 D1: the admission of the Portal Auth source worker -> Communications hop. Commerce Customer Context's source worker
 * calls the public `submit-communication-request` Action as the registered workload `communications.core.request-source`,
 * naming the declaration `communications.core.communication-request.submit`, from its own Outbox delivery.
 *
 * What is REAL: Core's access decision service over the Action's own declared carrier (the declaration beside the workload),
 * with a context sealed the way the Shell seals that worker's delivery, and then the Action's handler over native
 * PostgreSQL for a request whose source is the sealed calling module. The workload registry is the one port scripted here:
 * it answers the active workload keys a principal holds in ONE Tenant, as Core's registry does under row-level security.
 * What is NOT run: the Shell issuing the assertion and the HTTP transport (see `production-http-authorization.test.ts`).
 */

const REVISION = 'c'.repeat(64);
const SOURCE_MODULE = 'commerce.customer-context';
const REQUEST_SOURCE = 'communications.core.request-source';
const WORKER_PRINCIPAL = '77777777-7777-4777-8777-0000000000d1';
const TENANT = '11111111-1111-4111-8111-0000000000d1';
const OTHER_TENANT = '22222222-2222-4222-8222-0000000000d1';

const workerIn = (tenantId: string, overrides?: SourceWorkerOverrides): OperationalScope =>
  asSourceWorker(
    {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authContextRef: 'job:commerce.customer-context.submit-portal-auth-communication-request:run:1',
        authMethod: 'system',
        principalId: WORKER_PRINCIPAL,
        tenantId,
      }),
      correlationId: 'registered-source-worker-admission',
    },
    SOURCE_MODULE,
    REVISION,
    undefined,
    overrides,
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
      carrier: submitCommunicationRequestAction.descriptor,
      legalEntityScope: submitCommunicationRequestAction.descriptor.legalEntityScope,
      now: new Date('2026-11-22T12:00:00.000Z'),
      scope,
    });
};

describe('The Portal Auth source worker -> Communications admission (#1406 D1)', () => {
  it.effect(
    'admits the worker of commerce.customer-context registered as the request-source workload in its Tenant',
    () =>
      Effect.gen(function* admitted() {
        const decision = yield* gateWith({ [TENANT]: [REQUEST_SOURCE] })(workerIn(TENANT));
        expect(decision.outcome).toBe('ALLOWED');
        expect(decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
      }),
  );

  it.effect('refuses the worker in a Tenant that registered no request-source workload for it', () =>
    Effect.gen(function* otherTenant() {
      // registered in one Tenant only: a delivery of another Tenant is never admitted by that registration
      const decision = yield* gateWith({ [TENANT]: [REQUEST_SOURCE] })(workerIn(OTHER_TENANT));
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
    }),
  );

  it.effect('refuses a principal registered only as another workload', () =>
    Effect.gen(function* otherRegistration() {
      const decision = yield* gateWith({ [TENANT]: ['payment.source-ingress'] })(workerIn(TENANT));
      expect(decision.outcome).toBe('DENIED');
    }),
  );

  it.effect('refuses an assertion naming another workload or another declaration, however the registry is bound', () =>
    Effect.gen(function* otherAssertion() {
      const gate = gateWith({ [TENANT]: [REQUEST_SOURCE, 'payment.source-ingress'] });
      const otherWorkload = yield* gate(workerIn(TENANT, { workloadKey: 'payment.source-ingress' }));
      expect(otherWorkload.outcome).not.toBe('ALLOWED');
      // the pre-admission spelling of the call (an Action key, not a declaration) is not this Action's declaration
      const otherDeclaration = yield* gate(
        workerIn(TENANT, { declarationKey: 'communications.core.submit-communication-request' }),
      );
      expect(otherDeclaration.outcome).not.toBe('ALLOWED');
    }),
  );

  it.live('the handler decides the request of the sealed calling module and refuses any other source module', () =>
    Effect.gen(function* handler() {
      // a FICTIONAL approved type whose source owner is the calling module
      const world = yield* intakeWorld(yield* makeRuntimeDatabase(), {
        types: [fixtureType({ sourceOwner: SOURCE_MODULE })],
      });
      const request = communicationRequest({
        bindings: [originalRecipient('customer-1')],
        occurrenceId: 'portal-auth-issuance-1',
        sourceModule: SOURCE_MODULE,
        tenantId: world.tenantId,
      });
      const accepted = decided(
        yield* world.runner.submit(world.tenantId, request, '00000000-0000-4000-8000-0000000000d1', SOURCE_MODULE),
      );
      expect(accepted.decision.kind).toBe('MESSAGE_INTENTS');
      // the same request delivered by a worker of another module: its claimed source is not the verified caller
      const failure = yield* Effect.flip(
        world.runner.submit(world.tenantId, request, '00000000-0000-4000-8000-0000000000d2', 'payment.core'),
      );
      expect(Schema.is(CommunicationRequestSourceMismatch)(failure)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
