import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  AKROS_LEGAL_ENTITY_ID,
  assertCommandAllowed,
  assertStorefrontScope,
  ESHOP_LEGAL_ENTITY_ID,
  isStorefrontServiceKey,
  principalKindOf,
  storefrontReadRequest,
  withCommandGuard,
} from '../../shared/actions/command-guard.ts';
import { MerchandisePermissionDenied } from '../../shared/errors/merchandise-permission-denied.ts';

const deniedCommands = ['BulkUpdateProducts', 'ChangePrice', 'EditOrder'] as const;

it('forces e-shop API keys into the public view even if the flag is omitted or false', () => {
  const request = { view: { orderClientRequestId: 'guest-request', storefront: false } };
  expect(storefrontReadRequest('api_key', ESHOP_LEGAL_ENTITY_ID, {})).toEqual({ view: { storefront: true } });
  expect(storefrontReadRequest('api_key', ESHOP_LEGAL_ENTITY_ID, request)).toEqual({
    view: { orderClientRequestId: 'guest-request', storefront: true },
  });
  expect(storefrontReadRequest('session', ESHOP_LEGAL_ENTITY_ID, request)).toBe(request);
  expect(storefrontReadRequest('api_key', 'other-company', request)).toBe(request);
});

it.effect('only allows guest order placement for the storefront company key', () =>
  Effect.gen(function* storefrontCommands() {
    yield* assertStorefrontScope('api_key', ESHOP_LEGAL_ENTITY_ID, 'PlaceStorefrontOrder');
    for (const tag of ['EditOrder', 'ChangeOrderStatus', 'UpdateProduct', 'CreateOrder']) {
      const failure = yield* assertStorefrontScope('api_key', ESHOP_LEGAL_ENTITY_ID, tag).pipe(Effect.flip);
      expect(isRejection(failure)).toBe(true);
      yield* assertStorefrontScope('session', ESHOP_LEGAL_ENTITY_ID, tag);
    }
    yield* assertStorefrontScope('api_key', 'other-company', 'CreateOrder');
  }),
);
const isRejection = Schema.is(MerchandisePermissionDenied);

it('treats sessions as human and API keys or system jobs as non-human', () => {
  expect(principalKindOf('session')).toBe('human');
  expect(principalKindOf('support_impersonation')).toBe('human');
  expect(principalKindOf('api_key')).toBe('non_human');
  expect(principalKindOf('system')).toBe('non_human');
});

it.effect('lets humans run every command', () =>
  Effect.forEach(deniedCommands, (tag) => assertCommandAllowed('human', tag), { discard: true }),
);

it.effect('rejects reserved commands for non-human principals', () =>
  Effect.forEach(
    deniedCommands,
    (tag) =>
      assertCommandAllowed('non_human', tag).pipe(
        Effect.flip,
        Effect.map((failure) => expect(isRejection(failure)).toBe(true)),
      ),
    { discard: true },
  ),
);

it.effect('lets non-human principals run CreateProduct', () => assertCommandAllowed('non_human', 'CreateProduct'));

it.effect('guards the wrapped handler before it runs', () =>
  Effect.gen(function* guardedHandler() {
    let ran = false;
    const guarded = withCommandGuard(
      (
        _payload: { readonly command: { readonly _tag: string } },
        _context: { readonly scope: { readonly authMethod: 'api_key' | 'session' } },
      ) =>
        Effect.sync(() => {
          ran = true;
        }),
    );
    const failure = yield* guarded(
      { command: { _tag: 'BulkUpdateProducts' } },
      { scope: { authMethod: 'api_key' } },
    ).pipe(Effect.flip);
    expect(isRejection(failure)).toBe(true);
    expect(ran).toBe(false);
    yield* guarded({ command: { _tag: 'BulkUpdateProducts' } }, { scope: { authMethod: 'session' } });
    expect(ran).toBe(true);
  }),
);

it('treats an MCP connection as its person, and a connection for an agent as non-human', () => {
  expect(principalKindOf('oauth_connection')).toBe('human');
  expect(principalKindOf('oauth_connection', '72000000-0000-4000-8000-000000000021')).toBe('non_human');
  expect(principalKindOf('oauth_connection', undefined, 'AiDecideChanges')).toBe('non_human');
  expect(principalKindOf('oauth_connection', undefined, 'ChangePrice')).toBe('human');
});

it('limits only the storefront API key to the public catalog', () => {
  const request = { view: {} };
  expect(storefrontReadRequest('oauth_connection', AKROS_LEGAL_ENTITY_ID, request)).toBe(request);
  expect(storefrontReadRequest('api_key', AKROS_LEGAL_ENTITY_ID, {})).toEqual({ view: { storefront: true } });
  expect(isStorefrontServiceKey('oauth_connection', AKROS_LEGAL_ENTITY_ID)).toBe(false);
  expect(isStorefrontServiceKey('api_key', AKROS_LEGAL_ENTITY_ID)).toBe(true);
});
