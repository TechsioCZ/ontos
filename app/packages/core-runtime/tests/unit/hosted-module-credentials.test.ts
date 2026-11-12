import { Config, ConfigProvider, Effect, Exit, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { HostedModuleCredentialsSchema, MODULE_CREDENTIAL_VARIABLE } from '../../src/auth/hosted-module-credentials.ts';
import { ownerModuleCredentialConfigProvider } from '../../src/auth/owner-module-credential.ts';
import { moduleAppIdOf, modulePrincipalDisplayName, PLATFORM_TENANT } from '../../src/auth/module-credentials.ts';

const ORDER_KEY = 'order-module-credential-0001';
const CART_KEY = 'cart-module-credential-00002';
const hosted = new Map([
  ['commerce-order', Redacted.make(ORDER_KEY)],
  ['commerce-cart', Redacted.make(CART_KEY)],
]);
const sharedEnvironment = ConfigProvider.fromUnknown({
  [MODULE_CREDENTIAL_VARIABLE]: 'shared-environment-credential',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'http://127.0.0.1:3000/shell-super-app-api',
});

const read = (provider: ConfigProvider.ConfigProvider, key: string) => Effect.exit(Config.String(key).parse(provider));

it.effect('gives a hosted owner its own module credential and nothing of the shared environment', () =>
  Effect.gen(function* ownCredentialOnly() {
    const order = ownerModuleCredentialConfigProvider(sharedEnvironment, 'commerce-order', () => hosted);
    expect(yield* read(order, MODULE_CREDENTIAL_VARIABLE)).toStrictEqual(Exit.succeed(ORDER_KEY));
    // Every other setting still comes from the host.
    expect(yield* read(order, 'ONTOS_SHELL_GATEWAY_BASE_URL')).toStrictEqual(
      Exit.succeed('http://127.0.0.1:3000/shell-super-app-api'),
    );
    const cart = ownerModuleCredentialConfigProvider(sharedEnvironment, 'commerce-cart', () => hosted);
    expect(yield* read(cart, MODULE_CREDENTIAL_VARIABLE)).toStrictEqual(Exit.succeed(CART_KEY));
  }),
);

it.effect('leaves a hosted owner without a credential instead of reading the shared environment', () =>
  Effect.gen(function* noCredentialFailsClosed() {
    const pricing = ownerModuleCredentialConfigProvider(sharedEnvironment, 'pricing', () => hosted);
    expect(Exit.isFailure(yield* read(pricing, MODULE_CREDENTIAL_VARIABLE))).toBe(true);
  }),
);

it.effect('lets a dedicated module deployment read its own environment', () =>
  Effect.gen(function* dedicatedDeployment() {
    const dedicated = ownerModuleCredentialConfigProvider(sharedEnvironment, 'commerce-order', () => null);
    expect(yield* read(dedicated, MODULE_CREDENTIAL_VARIABLE)).toStrictEqual(
      Exit.succeed('shared-environment-credential'),
    );
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
