import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import {
  assertCommandAllowed,
  isStorefrontAdmission,
  principalKindOf,
  withCommandGuard,
} from '../../shared/actions/command-guard.ts';
import { MerchandisePermissionDenied } from '../../shared/errors/merchandise-permission-denied.ts';
import { placeStorefrontOrderAction } from '../../src/actions/place-storefront-order.action.ts';
import { merchandiseRuntimeDeclaration } from '../../vertical.runtime-declaration.ts';

const deniedCommands = ['BulkUpdateProducts', 'ChangePrice', 'EditOrder', 'ConfigureStorefrontCatalog'] as const;

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

it('recognizes the Storefront BFF only by its Core workload admission, never by key kind or company', () => {
  expect(isStorefrontAdmission({ outcome: 'ALLOWED', reasons: [{ code: 'allow.workload' }] })).toBe(true);
  // A person, an MCP connection or any key holding its own grants is admitted by them, in every company.
  expect(isStorefrontAdmission({ outcome: 'ALLOWED', reasons: [{ code: 'allow.granted' }] })).toBe(false);
  expect(isStorefrontAdmission({ outcome: 'DENIED', reasons: [{ code: 'deny.workload_unbound' }] })).toBe(false);
  expect(isStorefrontAdmission({ outcome: 'UNAVAILABLE', reasons: [{ code: 'unavailable.engine' }] })).toBe(false);
});

type CommandInput = typeof MerchandiseCommandSchema.Encoded;
const guestOrder: CommandInput = {
  _tag: 'PlaceStorefrontOrder',
  clientRequestId: 'order-request-1',
  lines: [{ expectedUnitPriceMinor: 121, productId: 'product-1', quantity: 1 }],
  shippingMethod: 'OSOBNI_ODBER',
};
const staffCommands: readonly CommandInput[] = [
  { _tag: 'ChangePrice', id: 'product-1', priceMinor: 16 },
  { _tag: 'ChangeOrderStatus', id: 'order-1', status: 'CONFIRMED' },
  { _tag: 'RecordStockMovement', delta: 1, productId: 'product-1', reason: 'RECEIPT' },
  { _tag: 'ArchiveDemoProduct', id: 'product-1', reason: 'Remove demo fixture' },
];

const decodesAsCommand = Schema.decodeUnknownOption(MerchandiseCommandSchema);
const decodesAsStorefrontOrder = (command: CommandInput) =>
  Option.isSome(
    Schema.decodeUnknownOption(placeStorefrontOrderAction.descriptor.payloadSchema)({ command, expectedRevision: 0 }),
  );

it('admits the Storefront workload, in any company, only to the guest order', () => {
  const storefrontActions = merchandiseRuntimeDeclaration.actions.filter(
    (action) => action.descriptor.accessWorkload?.workloads.includes('demo.storefront-client') === true,
  );
  expect(storefrontActions).toEqual([placeStorefrontOrderAction]);
  for (const command of staffCommands) {
    expect(Option.isSome(decodesAsCommand(command))).toBe(true);
    expect(decodesAsStorefrontOrder(command)).toBe(false);
  }
  expect(decodesAsStorefrontOrder(guestOrder)).toBe(true);
});
