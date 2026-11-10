import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  HostedModuleCredentialsSealedError,
  isHostedModuleCredentialProcess,
  MODULE_CREDENTIAL_VARIABLE,
  moduleCredentialConfigProvider,
  sealHostedModuleCredentials,
} from '../../src/auth/hosted-module-credentials.ts';

const ORDER_KEY = 'order-module-credential-0001';

it.effect('seals a multi-owner process once, after which each owner reads only its sealed entry', () =>
  Effect.gen(function* sealOnce() {
    const environment = ConfigProvider.fromUnknown({ [MODULE_CREDENTIAL_VARIABLE]: 'environment-credential-000' });
    const owner = moduleCredentialConfigProvider(environment, 'commerce-order');
    // A fresh read each time, as every delegated call reads its credential.
    const read = Effect.suspend(() => Config.String(MODULE_CREDENTIAL_VARIABLE).parse(owner));
    expect(isHostedModuleCredentialProcess()).toBe(false);
    expect(yield* read).toBe('environment-credential-000');
    yield* sealHostedModuleCredentials({
      credentials: { 'commerce-order': Redacted.make(ORDER_KEY) },
      schemaVersion: 1,
    });
    expect(isHostedModuleCredentialProcess()).toBe(true);
    expect(yield* read).toBe(ORDER_KEY);
    const refused = yield* Effect.flip(
      sealHostedModuleCredentials({
        credentials: { 'commerce-order': Redacted.make('another-module-key-0000') },
        schemaVersion: 1,
      }),
    );
    expect(Schema.is(HostedModuleCredentialsSealedError)(refused)).toBe(true);
    expect(yield* read).toBe(ORDER_KEY);
  }),
);
