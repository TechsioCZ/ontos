import { expect, it } from 'effect-rstest';
import { Effect, Option } from 'effect';
import {
  makeGatewayApiKeyBindingResolver,
  parseGatewayApiKeyBindings,
} from '../../api/auth/gateway-api-key-binding.ts';

const binding = {
  audience: 'commerce-fx',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '40000000-0000-4000-8000-000000000001',
  providerKeyId: 'provider-key-1',
  tenantId: '30000000-0000-4000-8000-000000000001',
  trustedStorefrontId: 'storefront:akros-b2b',
} as const;

const lookup = {
  audience: binding.audience,
  legalEntityId: binding.legalEntityId,
  principalId: binding.principalId,
  providerKeyId: binding.providerKeyId,
  tenantId: binding.tenantId,
} as const;

it.effect('resolves Storefront only from an exact deployment-owned API-key binding', () =>
  Effect.gen(function* exactBinding() {
    const configuredBindings = yield* parseGatewayApiKeyBindings({
      ONTOS_GATEWAY_API_KEY_CONTEXT_BINDINGS: JSON.stringify([binding]),
    });
    const [configuredBinding] = configuredBindings;
    expect(configuredBinding).toBeDefined();
    if (configuredBinding === undefined) {
      return;
    }
    const resolver = makeGatewayApiKeyBindingResolver([configuredBinding]);

    expect(yield* resolver.resolve(lookup)).toEqual(Option.some(configuredBinding));
    expect(
      yield* resolver.resolve({ ...lookup, providerKeyId: 'caller-selected-provider-key' }),
    ).toEqual(Option.none());
    expect(
      yield* resolver.resolve({ ...lookup, legalEntityId: '20000000-0000-4000-8000-000000000002' }),
    ).toEqual(Option.none());
  }),
);

it.effect('parses the server configuration and rejects duplicate binding keys', () =>
  Effect.gen(function* parseBindings() {
    expect(
      yield* parseGatewayApiKeyBindings({
        ONTOS_GATEWAY_API_KEY_CONTEXT_BINDINGS: JSON.stringify([binding]),
      }),
    ).toEqual([binding]);

    const malformed = yield* Effect.flip(
      parseGatewayApiKeyBindings({
        ONTOS_GATEWAY_API_KEY_CONTEXT_BINDINGS: JSON.stringify([binding, binding]),
      }),
    );
    expect(malformed.message).toBe('Gateway API-key context binding configuration is malformed');
  }),
);
