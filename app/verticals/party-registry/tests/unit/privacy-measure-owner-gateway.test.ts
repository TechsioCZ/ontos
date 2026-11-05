import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';
import { ConfigProvider, Effect, Layer, Result, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import {
  PrivacyMeasureOwnerGateway,
  PrivacyMeasureOwnerGatewayLive,
} from '../../src/workers/privacy-measure-owner-gateway.ts';

/** The failure shape the owner's recording endpoint answers with when it refuses a request. */
interface OwnerRecordingFailure {
  readonly code?: string;
  readonly resolution?: string;
}

const acquiredRequests = rs.hoisted((): GatewayDelegationRequest[] => []);
const clients = rs.hoisted(() => ({
  recordOutcome: rs.fn<() => Effect.Effect<unknown, OwnerRecordingFailure>>(),
}));

// Script only the external clients; exercise the shipped gateway and its failure classification.
rs.mock('@app/shared-contracts/gateway-context-server', () => ({
  acquireDelegatedGatewayContext: (request: GatewayDelegationRequest) => {
    acquiredRequests.push(request);
    return Effect.succeed({ authorization: 'Bearer fixture-token' });
  },
}));
rs.mock('@app/privacy/api/client', () => ({
  executeRecordOwnerExecutionOutcomeWithAuthorization: clients.recordOutcome,
}));
const originator = {
  actionInvocationId: '40000000-0000-4000-8000-000000000004',
  tenantId: '10000000-0000-4000-8000-000000000001',
};

const outcome = OwnerExecutionOutcomeSchema.make({
  attempt: 1,
  evidenceRefs: ['evidence:1'],
  idempotencyKey: 'party-privacy-measure:1',
  includedResourceRefs: [],
  measureId: 'measure:1',
  occurredAt: '2026-09-14T10:01:00.000Z',
  outcomeId: 'outcome:1',
  owningCapability: 'party.registry',
  reason: 'The owner completed the measure',
  recordedAt: '2026-09-14T10:01:00.000Z',
  remainingResourceRefs: [],
  sourceDecisionRef: 'decision:1',
  sourceDecisionRevision: 1,
  status: 'SUCCEEDED',
  taskId: 'task:1',
});
const accepted = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2035-01-01T12:00:00.000Z',
  proposalId: '10000000-0000-4000-8000-000000000001',
});
const gatewayLive = PrivacyMeasureOwnerGatewayLive.pipe(
  Layer.provide(nodeCryptoLayer),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_PARTY_REGISTRY_API_BASE_URL: 'https://party.fixture.test',
        ONTOS_PRIVACY_API_BASE_URL: 'https://privacy.fixture.test',
      }),
    ),
  ),
);
const report = (response: Effect.Effect<unknown, OwnerRecordingFailure>) => {
  clients.recordOutcome.mockReturnValue(response);
  return Effect.gen(function* reportThroughShippedGateway() {
    const gateway = yield* PrivacyMeasureOwnerGateway;
    yield* gateway.report(outcome, 'correlation:1', 'composition:1', originator);
  });
};

it.layer(gatewayLive)('privacy measure owner gateway', (suite) => {
  suite.effect('acts for the originating invocation and never for a module credential', () =>
    Effect.gen(function* actForOriginator() {
      clients.recordOutcome.mockReturnValue(Effect.succeed(outcome));
      yield* report(Effect.succeed(outcome));
      const request = acquiredRequests.at(-1);
      expect(request).toMatchObject({
        audience: 'privacy',
        legalEntityScope: 'subject',
        requestCorrelation: 'correlation:1',
        subject: {
          _tag: 'Originator',
          actionInvocationId: originator.actionInvocationId,
          compositionRevision: 'composition:1',
          tenantId: originator.tenantId,
        },
      });
    }),
  );

  suite.effect('does not acknowledge a parked outcome-recording proposal as a completed report', () =>
    Effect.gen(function* refuseParkedReport() {
      expect(Schema.is(ActionProposalAcceptedSchema)(accepted)).toBe(true);
      const result = yield* Effect.result(report(Effect.succeed(accepted)));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: 'OWNER_GATEWAY_UNAVAILABLE', retryable: true });
      }
    }),
  );

  suite.effect('acknowledges a genuinely recorded owner outcome', () => report(Effect.succeed(outcome)));

  suite.effect('preserves acknowledgement of an already committed report replay', () =>
    report(Effect.fail({ code: 'action_already_committed', resolution: 'REFRESH_GOVERNED_READS' })),
  );

  suite.effect('keeps an indeterminate report commit retryable and distinct from a completed report', () =>
    Effect.gen(function* preserveIndeterminateCommit() {
      const result = yield* Effect.result(report(Effect.fail({ resolution: 'RESOLVE_COMMIT' })));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: 'OWNER_COMMIT_INDETERMINATE', retryable: true });
      }
    }),
  );
});
