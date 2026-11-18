import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { OwnerExecutionOutcomeSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { ConfigProvider, Effect, Layer, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  PrivacyMeasureOwnerGateway,
  PrivacyMeasureOwnerGatewayLive,
} from '../../src/workers/privacy-measure-owner-gateway.ts';

const compositionRevision = 'd'.repeat(64);
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
// The actual delegated Shell client and Privacy Action client run over this fake HTTP peer pair: the Shell
// issues the originator's bearer, and Privacy answers the outcome report with the scripted reply.
const reportPath = '/privacy/actions/record-owner-execution-outcome';
const delegatedPath = '/shell-super-app-api/auth/delegated/gateway-context';
const transportConfiguration = {
  ONTOS_GATEWAY_MODULE_API_KEY: 'party-fixture-module-key',
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
// Configuration and the transport stay in the suite's context: the gateway reads them per owner call.
const gatewayLive = PrivacyMeasureOwnerGatewayLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      nodeCryptoLayer,
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...transportConfiguration,
          ONTOS_PARTY_REGISTRY_API_BASE_URL: 'https://party.fixture.test',
          ONTOS_PRIVACY_API_BASE_URL: 'https://privacy.fixture.test',
        }),
      ),
      Layer.succeed(FetchHttpClient.Fetch, transport.fetch),
    ),
  ),
);
const report = (reply: () => Response) =>
  Effect.gen(function* reportThroughShippedGateway() {
    transport.reply(reply);
    const gateway = yield* PrivacyMeasureOwnerGateway;
    yield* gateway.report(outcome, 'correlation:1', compositionRevision, originator);
  });
const recorded = () => Response.json(Schema.encodeSync(OwnerExecutionOutcomeSchema)(outcome));

it.layer(gatewayLive)('privacy measure owner gateway', (suite) => {
  suite.effect('acts for the originating invocation and never for a module credential', () =>
    Effect.gen(function* actForOriginator() {
      yield* report(recorded);
      const request = (yield* transport.delegatedBodies).at(-1);
      expect(request).toMatchObject({
        audience: 'privacy',
        compositionRevision,
        legalEntityScope: 'subject',
        subject: {
          _tag: 'Originator',
          actionInvocationId: originator.actionInvocationId,
          tenantId: originator.tenantId,
        },
      });
      const delegated = transport.requests.findLast((sent) => new URL(sent.url).pathname === delegatedPath);
      expect(delegated?.headers.get('x-correlation-id')).toBe('correlation:1');
    }),
  );

  suite.effect('does not acknowledge a parked outcome-recording proposal as a completed report', () =>
    Effect.gen(function* refuseParkedReport() {
      expect(Schema.is(ActionProposalAcceptedSchema)(accepted)).toBe(true);
      const encodedAccepted = yield* Schema.encodeEffect(ActionProposalAcceptedSchema)(accepted);
      const result = yield* Effect.result(report(() => Response.json(encodedAccepted, { status: 202 })));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: 'OWNER_GATEWAY_UNAVAILABLE', retryable: true });
      }
    }),
  );

  suite.effect('acknowledges a genuinely recorded owner outcome', () => report(recorded));

  suite.effect('preserves acknowledgement of an already committed report replay', () => report(alreadyCommitted));

  suite.effect('keeps an indeterminate report commit retryable and distinct from a completed report', () =>
    Effect.gen(function* preserveIndeterminateCommit() {
      const result = yield* Effect.result(report(commitIndeterminate));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: 'OWNER_COMMIT_INDETERMINATE', retryable: true });
      }
    }),
  );
});
