// @rstest-environment node
import { ContextAccess, OAuthGrantRegistry } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { ConnectDraftRequestSchema } from '@app/shared-contracts/oauth-connections';
import { Crypto, Effect, Layer, Option, PlatformError, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeInstalledModuleCatalogLayer } from '../../../api/modules/installed-module-catalog.ts';
import { createDraft } from '../../../api/oauth-connections/connect-service.ts';
import type { ConnectSession } from '../../../api/oauth-connections/connect-service.ts';
import { ConnectionUnavailable } from '../../../api/oauth-connections/errors.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';
import { grantRegistryFixture, retainedGrant } from './grant-registry-fixture.ts';

const cryptoFailure = PlatformError.systemError({
  _tag: 'Unknown',
  method: 'randomUUIDv4',
  module: 'Crypto',
});
const session: ConnectSession = {
  activeLegalEntityId: retainedGrant.legalEntityId,
  authBindingId: retainedGrant.authBindingId ?? undefined,
  companies: [{ legalEntityId: retainedGrant.legalEntityId, legalName: 'Company' }],
  displayName: 'Person',
  principalId: retainedGrant.userPrincipalId,
  sessionId: retainedGrant.sessionId ?? '',
  tenantId: retainedGrant.tenantId,
  userId: retainedGrant.userId,
};

const fixture = (previousProfileId: Option.Option<string>, failCrypto = false) =>
  Effect.gen(function* draftFixture() {
    const request = yield* Schema.decodeEffect(ConnectDraftRequestSchema)({
      actingPrincipalId: null,
      legalEntityId: retainedGrant.legalEntityId,
      modules: 'all',
      oauthQuery: 'verified-query',
      writePolicy: 'read_only',
    });
    const snapshot = yield* makeCompositionSnapshot([]);
    const inserted: string[] = [];
    let uuidCalls = 0;
    const nativeCrypto = Crypto.make({
      digest: (_algorithm, data) => Effect.succeed(data),
      randomBytes: (size) => {
        uuidCalls += 1;
        return new Uint8Array(size).fill(7);
      },
    });
    const crypto: Crypto.Crypto = failCrypto
      ? {
          ...nativeCrypto,
          randomUUIDv4: () =>
            Effect.suspend(() => {
              uuidCalls += 1;
              return Effect.fail(cryptoFailure);
            }),
        }
      : nativeCrypto;
    const dependencies = Layer.mergeAll(
      Layer.succeed(Crypto.Crypto, crypto),
      makeInstalledModuleCatalogLayer(Effect.succeed(snapshot)),
      Layer.mock(ContextAccess, { modules: () => Effect.succeed([]) }),
      Layer.mock(ActionAuthority, { checkActionAuthorities: () => Effect.succeed([]) }),
      Layer.succeed(OAuthFlow, {
        deleteGrantTokens: () => Effect.die('Unexpected token deletion'),
        findClient: () =>
          Effect.succeed(
            Option.some({ clientId: retainedGrant.clientId, logoUri: null, name: retainedGrant.clientName }),
          ),
        verifyQuery: () =>
          Effect.succeed({
            agent: null,
            clientId: retainedGrant.clientId,
            company: null,
            redirectUri: 'https://client.example/callback',
            resource: null,
            scope: 'ontos',
            state: null,
          }),
      }),
      Layer.succeed(
        OAuthGrantRegistry,
        grantRegistryFixture({
          findPreviousProfileId: () => Effect.succeed(previousProfileId),
          insertDraftGrant: (input) =>
            Effect.sync(() => {
              inserted.push(input.profileId);
              return { ...retainedGrant, ...input, status: 'draft' };
            }),
        }),
      ),
    );
    return {
      inserted,
      run: createDraft(session, request).pipe(Effect.provide(dependencies)),
      uuidCalls: () => uuidCalls,
    };
  });

it.effect('reuses a previous profile without generating a UUID, even when Crypto is unavailable', () =>
  Effect.gen(function* reuseProfile() {
    const test = yield* fixture(Option.some(retainedGrant.profileId), true);
    expect(yield* test.run).toEqual({ grantId: retainedGrant.grantId });
    expect(test.inserted).toEqual([retainedGrant.profileId]);
    expect(test.uuidCalls()).toBe(0);
  }),
);

it.effect('generates exactly one native UUIDv4 when the previous profile is absent', () =>
  Effect.gen(function* newProfile() {
    const test = yield* fixture(Option.none());
    expect(yield* test.run).toEqual({ grantId: retainedGrant.grantId });
    expect(test.inserted).toEqual(['07070707-0707-4707-8707-070707070707']);
    expect(test.uuidCalls()).toBe(1);
  }),
);

it.effect('maps UUID failure to ConnectionUnavailable before inserting a draft', () =>
  Effect.gen(function* failedProfile() {
    const test = yield* fixture(Option.none(), true);
    const error = yield* Effect.flip(test.run);
    expect(error).toBeInstanceOf(ConnectionUnavailable);
    expect(error).toHaveProperty('cause', cryptoFailure);
    expect(test.inserted).toEqual([]);
    expect(test.uuidCalls()).toBe(1);
  }),
);
