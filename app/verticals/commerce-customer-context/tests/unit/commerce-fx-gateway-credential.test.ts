import { expect, it } from 'effect-rstest';
import { Effect, Redacted } from 'effect';
import { makeCommerceFxGatewayCredentialIssuer } from '../../api/commerce-fx-gateway-credential.ts';

it.effect('issues FX credentials without transporting Storefront scope', () =>
  Effect.gen(function* issueServerCredential() {
    const calls: { readonly options: object; readonly payload: object }[] = [];
    const issuer = makeCommerceFxGatewayCredentialIssuer(
      {
        apiKey: Redacted.make('server-owned-key'),
        baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
      },
      (payload, options) => {
        calls.push({ options, payload });
        return Effect.succeed({ expiresAt: 1_700_000_300, token: 'fresh-signed-assertion' });
      },
    );

    const credential = yield* issuer.issue({
      audience: 'commerce-fx',
      legalEntityId: '20000000-0000-4000-8000-000000000001',
      requestCorrelation: 'purchase-limit-fx-correlation',
    });

    expect(Redacted.value(credential)).toBe('Bearer fresh-signed-assertion');
    expect(calls).toEqual([
      {
        options: {
          apiKey: expect.anything(),
          baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
          requestCorrelation: 'purchase-limit-fx-correlation',
        },
        payload: {
          audience: 'commerce-fx',
          legalEntityId: '20000000-0000-4000-8000-000000000001',
        },
      },
    ]);
    expect(calls[0]?.payload).not.toHaveProperty('trustedStorefrontId');
    expect(calls[0]?.options).not.toHaveProperty('trustedStorefrontId');
  }),
);
