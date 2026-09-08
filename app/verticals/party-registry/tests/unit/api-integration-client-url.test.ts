import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { AresSubjectLookupIcoSchema } from '../../shared/domain/ares-evidence.ts';
import { executeAresLookupWithAuthorization } from '../../src/api/ares-lookup-client.ts';
import { loadPartiesClientWithAuthorization } from '../../src/api/parties-search-client.ts';
import { executePartyDetailWithAuthorization } from '../../src/api/party-detail-client.ts';

const ico = Schema.decodeUnknownSync(AresSubjectLookupIcoSchema)('12345678');

it.effect(
  'targets the mounted owner BFF prefix and supports a separate owner deployment',
  () =>
    Effect.gen(function* testProgram1() {
      const requests: string[] = [];
      const fakeFetch: typeof globalThis.fetch = (input) => {
        requests.push(String(input));
        return Promise.resolve(new Response(null, { status: 503 }));
      };
      const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (location === undefined) {
            Reflect.deleteProperty(globalThis, 'location');
          } else {
            Object.defineProperty(globalThis, 'location', location);
          }
        })
      );
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { origin: 'https://shell.example', pathname: '/en/contacts' },
      });
      const capture = <Success, Failure>(
        request: Effect.Effect<Success, Failure>
      ) =>
        request.pipe(
          Effect.result,
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
        );
      yield* capture(
        executeAresLookupWithAuthorization({ ico }, 'Bearer test', 'test')
      );
      yield* capture(
        executePartyDetailWithAuthorization(
          {
            partyRef: {
              moduleId: 'party.registry',
              resourceId: '10000000-0000-4000-8000-000000000001',
              resourceType: 'party.registry.party',
              tenantId: '20000000-0000-4000-8000-000000000001',
            },
          },
          'Bearer test',
          'test'
        )
      );
      yield* capture(
        loadPartiesClientWithAuthorization(
          { query: 'Example' },
          'Bearer test',
          'test'
        )
      );
      yield* capture(
        executeAresLookupWithAuthorization({ ico }, 'Bearer test', 'test', {
          baseUrl: 'https://party.example/party-registry-api',
        })
      );
      expect(requests).toEqual([
        'https://shell.example/party-registry-api/reads/ares-lookup',
        'https://shell.example/party-registry-api/reads/party-detail',
        'https://shell.example/party-registry-api/party.registry/search/parties',
        'https://party.example/party-registry-api/reads/ares-lookup',
      ]);
    })
);
