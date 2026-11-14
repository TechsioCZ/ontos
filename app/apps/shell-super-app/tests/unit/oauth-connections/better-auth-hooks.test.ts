import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { OAuthGrantRegistry } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-service.ts';
import { OAuthGrantRegistryUnavailable } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-unavailable.ts';
import { makeOAuthConnectionHooks } from '../../../api/oauth-connections/better-auth-hooks.ts';
import { ConnectionInvalid } from '../../../api/oauth-connections/errors.ts';
import { grantRegistryFixture, retainedGrant } from './grant-registry-fixture.ts';

const session = { id: 's', userId: 'u' };
const makeHooks = (registry = grantRegistryFixture()) =>
  makeOAuthConnectionHooks().pipe(Effect.provideService(OAuthGrantRegistry, registry));

it.effect('customAccessTokenClaims preserves the exact grant consent reference', () =>
  Effect.gen(function* claims() {
    const hooks = yield* makeHooks();
    const result = yield* hooks.customAccessTokenClaims({ referenceId: retainedGrant.grantId });
    expect(result).toEqual({ 'https://ontos.cz/grant': retainedGrant.grantId });
  }),
);
it.effect('customAccessTokenClaims refuses a token without a grant', () =>
  Effect.gen(function* missingGrant() {
    const hooks = yield* makeHooks();
    for (const input of [{}, { referenceId: '' }]) {
      const error = yield* hooks.customAccessTokenClaims(input).pipe(Effect.flip);
      expect(error).toEqual(new ConnectionInvalid({ code: 'grant_not_found' }));
    }
  }),
);
it.effect('a fresh login redirects without a registry lookup', () =>
  Effect.gen(function* freshLogin() {
    const hooks = yield* makeHooks(
      grantRegistryFixture({ findSessionGrant: () => Effect.die('must not look up a fresh login') }),
    );
    expect(yield* hooks.shouldRedirect({ isContinuation: false, session })).toBe(true);
  }),
);
it.effect('continuations retain both the exact session and user correlation', () =>
  Effect.gen(function* correlation() {
    const seen: { readonly sessionId: string; readonly userId: string }[] = [];
    const hooks = yield* makeHooks(
      grantRegistryFixture({
        findSessionGrant: (input) => {
          seen.push(input);
          return Effect.succeed(Option.some(retainedGrant));
        },
      }),
    );
    expect(yield* hooks.consentReferenceId({ session })).toBe(retainedGrant.grantId);
    expect(yield* hooks.shouldRedirect({ isContinuation: true, session })).toBe(false);
    expect(seen).toEqual([
      { sessionId: 's', userId: 'u' },
      { sessionId: 's', userId: 'u' },
    ]);
  }),
);
it.effect('consent always rechecks the retained grant instead of caching a previous approval', () =>
  Effect.gen(function* retainedConsent() {
    let retained = true;
    const hooks = yield* makeHooks(
      grantRegistryFixture({
        findSessionGrant: () => Effect.sync(() => (retained ? Option.some(retainedGrant) : Option.none())),
      }),
    );
    // The consent page, approval and code issuance all retain the same real grant reference.
    for (let call = 0; call < 3; call += 1) {
      expect(yield* hooks.consentReferenceId({ session })).toBe(retainedGrant.grantId);
    }
    retained = false;
    expect(yield* hooks.shouldRedirect({ isContinuation: true, session })).toBe(true);
    expect(yield* hooks.consentReferenceId({ session }).pipe(Effect.flip)).toEqual(
      new ConnectionInvalid({ code: 'draft_not_found' }),
    );
  }),
);
it.effect('missing retained drafts redirect and cannot issue a consent reference', () =>
  Effect.gen(function* missingDraft() {
    const hooks = yield* makeHooks();
    expect(yield* hooks.shouldRedirect({ isContinuation: true, session })).toBe(true);
    expect(yield* hooks.consentReferenceId({ session }).pipe(Effect.flip)).toEqual(
      new ConnectionInvalid({ code: 'draft_not_found' }),
    );
  }),
);
it.effect('native registry failures stay typed and cannot grant consent or continue login', () =>
  Effect.gen(function* registryFailure() {
    const failure = new OAuthGrantRegistryUnavailable({ cause: 'driver unavailable' });
    const hooks = yield* makeHooks(grantRegistryFixture({ findSessionGrant: () => Effect.fail(failure) }));
    expect(yield* hooks.consentReferenceId({ session }).pipe(Effect.flip)).toBe(failure);
    expect(yield* hooks.shouldRedirect({ isContinuation: true, session }).pipe(Effect.flip)).toBe(failure);
  }),
);
