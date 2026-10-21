// Sales-demo command guard (plan 22). One `apply-command` executor grant covers every command of the module, so
// this pure guard narrows what non-human principals (the agent bot's managed API key, and MCP connections acting for
// an AI agent) may run. An MCP connection acting as its person is human and uses that person's grants.
import { Effect, Schema } from 'effect';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { MerchandisePermissionDenied } from '../errors/merchandise-permission-denied.ts';

export const PrincipalKindSchema = Schema.Literals(['human', 'non_human']);
export type PrincipalKind = typeof PrincipalKindSchema.Type;

/** Approving or reverting AI changes stays with people in the app: a connected MCP client never runs these. */
const AI_DECISION_COMMANDS: ReadonlySet<string> = new Set(['AiDecideChanges', 'AiRevertBatch']);

/**
 * Interactive sessions, support impersonation and an MCP connection acting as the person itself are human. A
 * connection acting for an AI agent (`delegatedByPrincipalId` set), API keys and system jobs are not.
 */
export const principalKindOf = (
  authMethod: TrustedPrincipalContext['authMethod'],
  delegatedByPrincipalId?: string,
  commandTag?: string,
): PrincipalKind =>
  authMethod === 'session' ||
  authMethod === 'support_impersonation' ||
  (authMethod === 'oauth_connection' &&
    delegatedByPrincipalId === undefined &&
    !AI_DECISION_COMMANDS.has(commandTag ?? ''))
    ? 'human'
    : 'non_human';

/** Commands reserved for human users; non-human principals (API keys, system jobs) are rejected. */
export const nonHumanForbiddenCommands: ReadonlySet<string> = new Set([
  'BulkUpdateProducts',
  'ChangePrice',
  'EditOrder',
  'RemoveDemoOrder',
  'ResetDemoData',
  'ArchiveDemoProduct',
  'UpdateCategory',
  // AI level C: an agent may only propose; a person approves or reverts in the app.
  'AiDecideChanges',
  'AiRevertBatch',
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
export const AKROS_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000024';
const isStorefrontCompany = (id: string | undefined) => id === ESHOP_LEGAL_ENTITY_ID || id === AKROS_LEGAL_ENTITY_ID;
export const ESHOP_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000023';
/** Only the storefront BFF's API key is limited to the storefront; people, MCP connections and agents use their grants. */
export const isStorefrontServiceKey = (
  authMethod: TrustedPrincipalContext['authMethod'],
  legalEntityId: string | undefined,
): boolean => authMethod === 'api_key' && isStorefrontCompany(legalEntityId);

/** An MCP connection may change the module directly only with write policy 'direct' and module write. */
export const connectionAllowsWrite = (
  scope: Partial<Pick<TrustedPrincipalContext, 'authMethod' | 'connection'>>,
  moduleKey: string,
): boolean => {
  if (scope.authMethod !== 'oauth_connection') {
    return true;
  }
  const { connection } = scope;
  if (connection === undefined || connection.writePolicy !== 'direct') {
    return false;
  }
  return (
    connection.modules === 'all' ||
    connection.modules.some((module) => module.moduleId === moduleKey && module.access === 'write')
  );
};
/** Commands the storefront service key may run inside the e-shop company: only the guest storefront order. */
export const storefrontOnlyCommands: ReadonlySet<string> = new Set(['PlaceStorefrontOrder']);

/** In the e-shop company, the storefront API key (the BFF) may place guest orders and nothing else. */
export const assertStorefrontScope = (
  authMethod: TrustedPrincipalContext['authMethod'],
  legalEntityId: string | undefined,
  commandTag: string,
): Effect.Effect<void, MerchandisePermissionDenied> =>
  !isStorefrontServiceKey(authMethod, legalEntityId) || storefrontOnlyCommands.has(commandTag)
    ? Effect.void
    : Effect.fail(
        new MerchandisePermissionDenied({
          code: 'merchandise_permission_denied',
          reason: `Merchandise command ${commandTag} is not available to the storefront`,
        }),
      );

/**
 * In the e-shop company, the storefront API key (the BFF key) only ever reads the public storefront view:
 * published active products and, at most, the one order it placed by `clientRequestId`. Staff data (all orders with
 * customer contacts, stock ledger, order indicators) stays server-side even if the key omits the storefront flag.
 */
export const storefrontReadRequest = <Request extends { readonly view?: { readonly storefront?: boolean } }>(
  authMethod: TrustedPrincipalContext['authMethod'],
  legalEntityId: string | undefined,
  request: Request,
): Request =>
  !isStorefrontServiceKey(authMethod, legalEntityId)
    ? request
    : { ...request, view: { ...request.view, storefront: true } };

/** Wraps the apply-command handler: the guard runs before any state is loaded. */
export const withCommandGuard =
  <
    Payload extends { readonly command: { readonly _tag: string } },
    Context extends { readonly scope: Pick<TrustedPrincipalContext, 'authMethod' | 'delegatedByPrincipalId' | 'legalEntityId'> },
    Success,
    Failure,
    Requirements,
  >(
    handler: (payload: Payload, context: Context) => Effect.Effect<Success, Failure, Requirements>,
  ) =>
  (payload: Payload, context: Context): Effect.Effect<Success, Failure | MerchandisePermissionDenied, Requirements> =>
    assertCommandAllowed(
      principalKindOf(context.scope.authMethod, context.scope.delegatedByPrincipalId, payload.command._tag),
      payload.command._tag,
    ).pipe(
      Effect.flatMap(() =>
        assertStorefrontScope(context.scope.authMethod, context.scope.legalEntityId, payload.command._tag),
      ),
      Effect.flatMap(() => handler(payload, context)),
    );

/** AKROS dispatch is operational only; catalog and money edits require a trusted administrator decision. */
export const staffCommandAllowed = (legalEntityId: string, administrator: boolean, commandTag: string): boolean =>
  commandTag === 'ResetDemoData'
    ? administrator && legalEntityId === AKROS_LEGAL_ENTITY_ID
    : commandTag === 'RemoveDemoOrder' || commandTag === 'ArchiveDemoProduct'
    ? administrator
    : legalEntityId !== AKROS_LEGAL_ENTITY_ID ||
      administrator ||
      commandTag === 'RecordStockMovement' ||
      commandTag === 'ChangeOrderStatus';
