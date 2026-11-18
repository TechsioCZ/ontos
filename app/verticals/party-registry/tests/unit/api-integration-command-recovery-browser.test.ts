// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://shell.example/en"}
import { pinDocumentCompositionRevision } from '@app/shared-contracts';
import { Effect, Match } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

import { recoverPartyCreate, resolvePartyCommandCommit } from '../../src/api/party-command-client.ts';
import {
  compositionRevision,
  createResult,
  invocationId,
  makeSingleUseOwnerResponse,
  recoveryCredential,
} from '../support/party-command-recovery.ts';

// Browser recovery runs in the Shell document it was served into: the client reads the pinned release
// from that document and acquires each assertion from the Shell at the document's own origin.
const approvedBrowserApiBasePath = '/module-api/party-registry/build-approved/party-registry-api';

const pinRecoveryDocument = pinDocumentCompositionRevision(compositionRevision);

const makeRecoveryAssertionFetch = (ownerResponse: (request: Request) => Response) => {
  const singleUse = makeSingleUseOwnerResponse(ownerResponse);
  const requests: Request[] = [];
  let assertions = 0;
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname !== '/shell-super-app-api/auth/gateway-context') {
      return Promise.resolve(singleUse.respond(request));
    }
    assertions += 1;
    return Promise.resolve(
      Response.json({
        apiBaseUrl: approvedBrowserApiBasePath,
        compositionRevision,
        expiresAt: 2_000_000_000,
        token: recoveryCredential(`fresh-${assertions}`).slice('Bearer '.length),
      }),
    );
  };
  return { assertions: () => assertions, fakeFetch, requests };
};

it.effect('recovery acquires a fresh assertion without submitting an idempotency key or re-running a command', () =>
  Effect.gen(function* testProgram3() {
    yield* pinRecoveryDocument;
    const { requests, assertions, fakeFetch } = makeRecoveryAssertionFetch(() =>
      Response.json({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
      }),
    );
    const result = yield* resolvePartyCommandCommit(
      { invocationId },
      {
        baseUrl: 'https://party.example/party-registry-api',
        correlationId: 'recovery',
        gateway: { baseUrl: 'https://shell.example/shell-super-app-api' },
        traceId: 'trace',
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(result.state).toBe('COMMITTED');
    expect(assertions()).toBe(1);
    expect(requests.length).toBe(2);
    const [, request] = requests;
    expect(Boolean(request)).toBe(true);
    if (request === undefined) {
      throw new Error('Expected truthy value');
    }
    expect(request.url).toBe(
      `https://shell.example${approvedBrowserApiBasePath}/party-registry/action-commits/resolve`,
    );
    expect(request.headers.get('authorization')).toBe(recoveryCredential('fresh-1'));
    expect(request.headers.get('idempotency-key')).toBe(null);
    expect(request.headers.get('x-correlation-id')).toBe('recovery');
    expect(request.headers.get('x-trace-id')).toBe('trace');
    expect(yield* Effect.promise(() => request.json())).toEqual({
      invocationId,
    });
  }),
);

it.effect('browser recovery uses the same owned invocation result, not reviewer authority', () =>
  Effect.gen(function* browserOwned() {
    yield* pinRecoveryDocument;
    const { requests, assertions, fakeFetch } = makeRecoveryAssertionFetch(() =>
      Response.json({
        _tag: 'PartyCommandCommitResolution',
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
        createResult: createResult('CREATED'),
      }),
    );
    const recovered = yield* recoverPartyCreate(
      { invocationId },
      { correlationId: 'browser-owned', gateway: { baseUrl: 'https://shell.example/shell-super-app-api' } },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    expect(
      Match.value(recovered).pipe(
        Match.tag('PartyCreateRecovered', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(assertions()).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => !request.url.includes('party-match-decision'))).toBe(true);
  }),
);
