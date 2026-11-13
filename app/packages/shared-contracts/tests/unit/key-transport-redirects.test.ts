import { NodeHttpServer } from '@effect/platform-node';
import { ReadPrincipalBindingPayloadSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, Exit, Match, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';

import { readPrincipalBinding } from '../../src/external-identity-client.ts';
import { issueApiKeyGatewayContext, issueDelegatedGatewayContext } from '../../src/gateway-context-api-key.ts';

const compositionRevision = 'c'.repeat(64);

/** One local server answering every request with `answer`; returns its origin. */
const localServer = (answer: (request: HttpServerRequest.HttpServerRequest) => HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* startLocalServer() {
    const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
      host: '127.0.0.1',
      port: 0,
    });
    yield* server.serve(HttpServerRequest.HttpServerRequest.use((request) => Effect.succeed(answer(request))));
    const address = yield* Match.value(server.address).pipe(
      Match.when(NetAddress.isInetAddress, (inetAddress) => Effect.succeed(inetAddress)),
      Match.orElse(() => Effect.die('The local server did not bind to TCP')),
    );
    return `http://127.0.0.1:${String(address.port)}`;
  });

/**
 * A key-carrying client never follows a redirect: the first server answers every request with 307 to a second one,
 * which records whether anything (and so any key header) ever reached it.
 */
it.live('never follows a redirect with a module, workload or gateway key in a header', () =>
  Effect.scoped(
    Effect.gen(function* redirectRefused() {
      const reached: string[] = [];
      const asked: string[] = [];
      const elsewhere = yield* localServer((request) => {
        reached.push(request.url);
        return HttpServerResponse.jsonUnsafe({});
      });
      const redirecting = yield* localServer((request) => {
        asked.push(request.url);
        return HttpServerResponse.empty({ headers: { location: `${elsewhere}${request.url}` }, status: 307 });
      });
      const options = {
        apiKey: Redacted.make('redirect-test-module-key-0000'),
        baseUrl: `${redirecting}/shell-super-app-api`,
        requestCorrelation: 'redirect-test-correlation',
      };
      const apiKeyIssue = yield* Effect.exit(
        issueApiKeyGatewayContext(
          { audience: 'party-registry', compositionRevision, legalEntityId: '30000000-0000-4000-8000-000000000001' },
          options,
        ),
      );
      const delegatedIssue = yield* Effect.exit(
        issueDelegatedGatewayContext(
          {
            audience: 'party-registry',
            compositionRevision,
            exchangeId: '30000000-0000-4000-8000-000000000002',
            legalEntityScope: 'tenant',
            subject: {
              _tag: 'Originator',
              actionInvocationId: '30000000-0000-4000-8000-000000000003',
              tenantId: '30000000-0000-4000-8000-000000000004',
            },
          },
          options,
        ),
      );
      const identityRead = yield* Effect.exit(
        readPrincipalBinding(
          Schema.decodeUnknownSync(ReadPrincipalBindingPayloadSchema)({
            authBindingId: '30000000-0000-4000-8000-000000000005',
            lookup: 'binding',
          }),
          { ...options, baseUrl: redirecting },
        ),
      );
      expect(Exit.isFailure(apiKeyIssue)).toBe(true);
      expect(Exit.isFailure(delegatedIssue)).toBe(true);
      expect(Exit.isFailure(identityRead)).toBe(true);
      expect(asked).toHaveLength(3);
      expect(reached).toEqual([]);
    }),
  ),
);
