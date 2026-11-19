import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { ConfigProvider, Effect, Layer, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { expect, it } from 'effect-rstest';

import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import {
  PrivacyMeasureOwnerGateway,
  PrivacyMeasureOwnerGatewayLive,
} from '../../src/workers/privacy-measure-owner-gateway.ts';

const compositionRevision = 'c'.repeat(64);
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
// The actual delegated Shell client and Privacy Action client run over this fake HTTP peer pair: the Shell
// issues the originator's bearer, and Privacy answers the outcome report with the scripted reply.
const reportPath = '/privacy/actions/record-owner-execution-outcome';
const delegatedPath = '/shell-super-app-api/auth/delegated/gateway-context';
const transportConfiguration = {
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.fixture.test/shell-super-app-api',
};
/** The Privacy Action's commit-resolution Problem Details extensions. */
interface CommitResolutionFields {
  readonly code?: 'action_already_committed';
  readonly invocationId: string;
  readonly resolution: 'REFRESH_GOVERNED_READS' | 'RESOLVE_COMMIT';
  readonly retryCommand: false;
}
const problem = (tag: string, status: number, fields: CommitResolutionFields) =>
  Response.json(
    { _tag: tag, detail: 'Privacy owner reply', status, title: 'Privacy owner reply', type: 'about:blank', ...fields },
    { headers: { 'content-type': 'application/problem+json' }, status },
  );
const alreadyCommitted = () =>
  problem('RecordOwnerExecutionOutcomeActionAlreadyCommittedProblem', 409, {
    code: 'action_already_committed',
    invocationId: 'privacy-invocation:1',
    resolution: 'REFRESH_GOVERNED_READS',
    retryCommand: false,
  });
const commitIndeterminate = () =>
  problem('RecordOwnerExecutionOutcomeActionCommitIndeterminateProblem', 503, {
    invocationId: 'privacy-invocation:1',
    resolution: 'RESOLVE_COMMIT',
    retryCommand: false,
  });
const unscriptedReply = () => Response.json({ detail: 'No scripted Privacy reply' }, { status: 500 });
const makePrivacyTransport = () => {
  const requests: Request[] = [];
  let reply = unscriptedReply;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (pathname === delegatedPath) {
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/privacy-api',
          compositionRevision,
          expiresAt: 2_000_000_000,
          token: 'privacy-token',
        }),
      );
    }
    return Promise.resolve(
      pathname === reportPath ? reply() : Response.json({ detail: 'Unknown route' }, { status: 404 }),
    );
  };
  const delegatedBodies = Effect.suspend(() =>
    Effect.forEach(
      requests.filter((request) => new URL(request.url).pathname === delegatedPath),
      (request) => Effect.promise(() => request.clone().json()),
    ),
  );
  return {
    delegatedBodies,
    fetch,
    reply: (next: () => Response) => {
      reply = next;
    },
    requests,
  };
};
const transport = makePrivacyTransport();
// Configuration and the transport stay in the test's context: the gateway reads them per owner call.
const configuredGateway = PrivacyMeasureOwnerGatewayLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      nodeCryptoLayer,
      // The caller's own key, handed over the way the host does; nothing reads a module key from configuration.
      Layer.effectDiscard(holdTestModuleCredentials({ 'commerce-customer-context': 'customer-fixture-module-key' })),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...transportConfiguration,
          ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL: 'https://customer.fixture.test',
          ONTOS_PRIVACY_API_BASE_URL: 'https://privacy.fixture.test',
        }),
      ),
      Layer.succeed(FetchHttpClient.Fetch, transport.fetch),
    ),
  ),
);

// Owner replies are scripted at the HTTP peer; acknowledgement and error mapping use the real customer gateway.
it.effect('acknowledges only an executed or already committed customer outcome report', () =>
  Effect.gen(function* customerReportAcknowledgement() {
    const gateway = yield* PrivacyMeasureOwnerGateway;
    const report = () => gateway.report(ownerOutcome, 'customer-report:1', compositionRevision, originator);
    const encodedOutcome = yield* Schema.encodeEffect(OwnerExecutionOutcomeSchema)(ownerOutcome);

    transport.reply(() => Response.json(encodedOutcome));
    yield* report();
    // Workers act for the invocation that originated the delivery, never for a module credential.
    const [delegated] = yield* transport.delegatedBodies;
    expect(delegated).toMatchObject({
      audience: 'privacy',
      compositionRevision,
      legalEntityScope: 'subject',
      subject: {
        _tag: 'Originator',
        actionInvocationId: originator.actionInvocationId,
        tenantId: originator.tenantId,
      },
    });
    expect(transport.requests[0]?.headers.get('x-correlation-id')).toBe('customer-report:1');

    // A retry after a lost reply carries the same key and payload, so Privacy answers the saved outcome.
    yield* report();
    const reportKeys = transport.requests
      .filter((request) => new URL(request.url).pathname === reportPath)
      .map((request) => request.headers.get('idempotency-key'));
    expect(reportKeys).toEqual(['owner-outcome:customer-measure:1:1', 'owner-outcome:customer-measure:1:1']);

    // An outcome Privacy committed before it saved replies still answers 409 action_already_committed.
    transport.reply(alreadyCommitted);
    yield* report();

    transport.reply(commitIndeterminate);
    const uncertain = yield* Effect.result(report());
    expect(Result.isFailure(uncertain)).toBe(true);
    if (Result.isFailure(uncertain)) {
      expect(uncertain.failure).toMatchObject({ code: 'OWNER_COMMIT_INDETERMINATE', retryable: true });
    }

    expect(Schema.is(ActionProposalAcceptedSchema)(parked)).toBe(true);
    const encodedParked = yield* Schema.encodeEffect(ActionProposalAcceptedSchema)(parked);
    transport.reply(() => Response.json(encodedParked, { status: 202 }));
    const unexecuted = yield* Effect.result(report());
    expect(Result.isFailure(unexecuted)).toBe(true);
    if (Result.isFailure(unexecuted)) {
      expect(unexecuted.failure).toMatchObject({ code: 'OWNER_GATEWAY_UNAVAILABLE', retryable: true });
    }
  }).pipe(Effect.provide(configuredGateway)),
);
