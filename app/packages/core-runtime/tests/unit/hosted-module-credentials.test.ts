import { ConfigProvider, Effect, Exit, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { claimHostedModuleCredentials } from '../../src/auth/hosted-module-credential-store.ts';
import { HostedModuleCredentialsSchema } from '../../src/auth/hosted-module-credentials.ts';
import { ownModuleCredential } from '../../src/auth/owner-module-credential.ts';
import { moduleAppIdOf, modulePrincipalDisplayName, PLATFORM_TENANT } from '../../src/auth/module-credentials.ts';

const ORDER_KEY = 'order-module-credential-0001';
const CART_KEY = 'cart-module-credential-00002';
/** An environment that wrongly carries a module key: no owner ever reads it. */
const sharedEnvironment = ConfigProvider.fromUnknown({
  ONTOS_GATEWAY_MODULE_API_KEY: 'shared-environment-credential',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'http://127.0.0.1:3000/shell-super-app-api',
});

const read = (appId: string) =>
  ownModuleCredential(appId).pipe(
    Effect.map((key) => (Option.isSome(key) ? Option.some(Redacted.value(key.value)) : Option.none<string>())),
    Effect.provideService(ConfigProvider.ConfigProvider, sharedEnvironment),
  );

// Declared first: the file's copy stays unclaimed until the next test claims it.
it.effect('gives a module in an unclaimed copy no credential, never the environment one', () =>
  Effect.gen(function* unclaimedCopy() {
    expect(yield* read('commerce-order')).toStrictEqual(Option.none());
  }),
);

it.effect('gives a hosted owner its own module credential and nothing of the shared environment', () =>
  Effect.gen(function* ownCredentialOnly() {
    const receiver = yield* claimHostedModuleCredentials(['commerce-order', 'commerce-cart', 'pricing']);
    yield* receiver.accept({
      credentials: { 'commerce-cart': Redacted.make(CART_KEY), 'commerce-order': Redacted.make(ORDER_KEY) },
      schemaVersion: 1,
    });
    expect(yield* read('commerce-order')).toStrictEqual(Option.some(ORDER_KEY));
    expect(yield* read('commerce-cart')).toStrictEqual(Option.some(CART_KEY));
    // A hosted owner without a handed-over key holds none instead of reading the shared environment.
    expect(yield* read('pricing')).toStrictEqual(Option.none());
  }),
);

it.effect('decodes a host handover with redacted keys and refuses short keys or unknown app ids', () =>
  Effect.gen(function* decodeHandover() {
    const decoded = yield* Schema.decodeUnknownEffect(HostedModuleCredentialsSchema)({
      credentials: { 'commerce-order': ORDER_KEY },
      schemaVersion: 1,
    });
    const credential = decoded.credentials['commerce-order'];
    expect(credential !== undefined && Redacted.isRedacted(credential)).toBe(true);
    expect(credential === undefined ? '' : Redacted.value(credential)).toBe(ORDER_KEY);
    for (const invalid of [
      { credentials: { 'commerce-order': 'short' }, schemaVersion: 1 },
      { credentials: { 'Commerce Order': ORDER_KEY }, schemaVersion: 1 },
      { credentials: {}, schemaVersion: 2 },
    ]) {
      expect(
        Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(HostedModuleCredentialsSchema)(invalid))),
      ).toBe(true);
    }
  }),
);

it('marks exactly the platform tenant module principals', () => {
  expect(modulePrincipalDisplayName('commerce-order')).toBe('module:commerce-order');
  expect(moduleAppIdOf('module:commerce-order')).toStrictEqual(Option.some('commerce-order'));
  for (const other of ['commerce-order', 'module:', 'module:Commerce', 'Module:commerce-order', 'module:a b']) {
    expect(Option.isNone(moduleAppIdOf(other))).toBe(true);
  }
  expect(PLATFORM_TENANT.tenantId).toMatch(/^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
});
