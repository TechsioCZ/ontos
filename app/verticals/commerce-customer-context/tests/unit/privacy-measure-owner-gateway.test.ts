import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { ConfigProvider, Effect, Layer, Result, Schema } from 'effect';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { expect, it, rs } from 'effect-rstest';

import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';

import {
  PrivacyMeasureOwnerGateway,
  PrivacyMeasureOwnerGatewayLive,
} from '../../src/workers/privacy-measure-owner-gateway.ts';

const recordOutcome = rs.hoisted(() => rs.fn<() => Effect.Effect<unknown, unknown>>());
const acquiredRequests = rs.hoisted((): GatewayDelegationRequest[] => []);
rs.mock('@app/privacy/api/client', () => ({ executeRecordOwnerExecutionOutcomeWithAuthorization: recordOutcome }));
rs.mock('@app/shared-contracts/gateway-context-server', () => ({
  acquireDelegatedGatewayContext: (request: GatewayDelegationRequest) => {
    acquiredRequests.push(request);
    return Effect.succeed({ authorization: 'Bearer customer-fixture-token' });
  },
}));
const originator = {
  actionInvocationId: '30000000-0000-4000-8000-000000000003',
  tenantId: '10000000-0000-4000-8000-000000000001',
};

const ownerOutcome = OwnerExecutionOutcomeSchema.make({
  attempt: 1,
  evidenceRefs: ['customer-evidence:1'],
  idempotencyKey: 'customer-privacy:1',
  includedResourceRefs: [],
  measureId: 'customer-measure:1',
  occurredAt: '2026-09-14T10:00:00.000Z',
  outcomeId: 'customer-outcome:1',
  owningCapability: 'commerce.customer-context',
  reason: 'The customer owner completed its measure',
  recordedAt: '2026-09-14T10:00:01.000Z',
  remainingResourceRefs: [],
  sourceDecisionRef: 'customer-decision:1',
  sourceDecisionRevision: 1,
  status: 'SUCCEEDED',
  taskId: 'customer-task:1',
});
const parked = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2035-01-01T00:00:00.000Z',
  proposalId: '20000000-0000-4000-8000-000000000002',
});
const configuredGateway = PrivacyMeasureOwnerGatewayLive.pipe(
  Layer.provide(nodeCryptoLayer),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL: 'https://customer.fixture.test',
        ONTOS_PRIVACY_API_BASE_URL: 'https://privacy.fixture.test',
      }),
    ),
  ),
);

// External replies are scripted; acknowledgement and error mapping use the real customer gateway.
it.effect('acknowledges only an executed or already committed customer outcome report', () =>
  Effect.gen(function* customerReportAcknowledgement() {
    const gateway = yield* PrivacyMeasureOwnerGateway;
    const report = () => gateway.report(ownerOutcome, 'customer-report:1', 'composition:1', originator);

    recordOutcome.mockReturnValue(Effect.succeed(ownerOutcome));
    yield* report();
    // Workers act for the invocation that originated the delivery, never for a module credential.
    expect(acquiredRequests[0]).toMatchObject({
      audience: 'privacy',
      legalEntityScope: 'subject',
      requestCorrelation: 'customer-report:1',
      subject: {
        _tag: 'Originator',
        actionInvocationId: originator.actionInvocationId,
        compositionRevision: 'composition:1',
        tenantId: originator.tenantId,
      },
    });

    recordOutcome.mockReturnValue(Effect.fail({ code: 'action_already_committed' }));
    yield* report();

    recordOutcome.mockReturnValue(Effect.fail({ resolution: 'RESOLVE_COMMIT' }));
    const uncertain = yield* Effect.result(report());
    expect(Result.isFailure(uncertain)).toBe(true);
    if (Result.isFailure(uncertain)) {
      expect(uncertain.failure).toMatchObject({ code: 'OWNER_COMMIT_INDETERMINATE', retryable: true });
    }

    expect(Schema.is(ActionProposalAcceptedSchema)(parked)).toBe(true);
    recordOutcome.mockReturnValue(Effect.succeed(parked));
    const unexecuted = yield* Effect.result(report());
    expect(Result.isFailure(unexecuted)).toBe(true);
    if (Result.isFailure(unexecuted)) {
      expect(unexecuted.failure).toMatchObject({ code: 'OWNER_GATEWAY_UNAVAILABLE', retryable: true });
    }
  }).pipe(Effect.provide(configuredGateway)),
);
