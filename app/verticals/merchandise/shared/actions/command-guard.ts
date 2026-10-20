// Sales-demo command guard (plan 22). One `apply-command` executor grant covers every command of the module, so
// this pure guard narrows what non-human principals (the agent bot's managed API key) may run.
import { Effect, Schema } from 'effect';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { MerchandisePermissionDenied } from '../errors/merchandise-permission-denied.ts';

export const PrincipalKindSchema = Schema.Literals(['human', 'non_human']);
export type PrincipalKind = typeof PrincipalKindSchema.Type;

/** Interactive sessions (also support impersonation) are human; API keys and system jobs are not. */
export const principalKindOf = (authMethod: TrustedPrincipalContext['authMethod']): PrincipalKind =>
  authMethod === 'session' || authMethod === 'support_impersonation' ? 'human' : 'non_human';

/** Commands reserved for human users; non-human principals (API keys, system jobs) are rejected. */
export const nonHumanForbiddenCommands: ReadonlySet<string> = new Set([
  'BulkUpdateProducts',
  'ChangePrice',
  'EditOrder',
]);
const forbidsCommand = (commandTag: string): boolean => nonHumanForbiddenCommands.has(commandTag);

export const assertCommandAllowed = (
  principalKind: PrincipalKind,
  commandTag: string,
): Effect.Effect<void, MerchandisePermissionDenied> =>
  principalKind === 'human' || !forbidsCommand(commandTag)
    ? Effect.void
    : Effect.fail(
        new MerchandisePermissionDenied({
          code: 'merchandise_permission_denied',
          reason: `Merchandise command ${commandTag} is reserved for human users`,
        }),
      );

/** The e-shop demo company (Kavárna Doma). Its non-human principal is the storefront BFF key. */
export const ESHOP_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000023';
/** Commands a non-human principal may run inside the e-shop company: only the guest storefront order. */
export const storefrontOnlyCommands: ReadonlySet<string> = new Set(['PlaceStorefrontOrder']);

/** In the e-shop company, API keys (the storefront BFF) may place guest orders and nothing else. */
export const assertStorefrontScope = (
  principalKind: PrincipalKind,
  legalEntityId: string | undefined,
  commandTag: string,
): Effect.Effect<void, MerchandisePermissionDenied> =>
  principalKind === 'human' || legalEntityId !== ESHOP_LEGAL_ENTITY_ID || storefrontOnlyCommands.has(commandTag)
    ? Effect.void
    : Effect.fail(
        new MerchandisePermissionDenied({
          code: 'merchandise_permission_denied',
          reason: `Merchandise command ${commandTag} is not available to the storefront`,
        }),
      );

/**
 * In the e-shop company, a non-human principal (the storefront BFF key) only ever reads the public storefront view:
 * published active products and, at most, the one order it placed by `clientRequestId`. Staff data (all orders with
 * customer contacts, stock ledger, order indicators) stays server-side even if the key omits the storefront flag.
 */
export const storefrontReadRequest = <Request extends { readonly view?: { readonly storefront?: boolean } }>(
  principalKind: PrincipalKind,
  legalEntityId: string | undefined,
  request: Request,
): Request =>
  principalKind === 'human' || legalEntityId !== ESHOP_LEGAL_ENTITY_ID
    ? request
    : { ...request, view: { ...request.view, storefront: true } };

/** Wraps the apply-command handler: the guard runs before any state is loaded. */
export const withCommandGuard =
  <
    Payload extends { readonly command: { readonly _tag: string } },
    Context extends { readonly scope: Pick<TrustedPrincipalContext, 'authMethod' | 'legalEntityId'> },
    Success,
    Failure,
    Requirements,
  >(
    handler: (payload: Payload, context: Context) => Effect.Effect<Success, Failure, Requirements>,
  ) =>
  (payload: Payload, context: Context): Effect.Effect<Success, Failure | MerchandisePermissionDenied, Requirements> =>
    assertCommandAllowed(principalKindOf(context.scope.authMethod), payload.command._tag).pipe(
      Effect.flatMap(() =>
        assertStorefrontScope(
          principalKindOf(context.scope.authMethod),
          context.scope.legalEntityId,
          payload.command._tag,
        ),
      ),
      Effect.flatMap(() => handler(payload, context)),
    );
