// Narrow registered Actions supply authority. This guard keeps the existing human-only protocol.
import { Effect, Predicate, Schema } from 'effect';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
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
  // Product photos are chosen and arranged by people.
  'ChangeProductImages',
  'EditOrder',
  'LinkOrderCustomer',
  'RemoveDemoOrder',
  'ResetDemoData',
  'ArchiveProduct',
  'RestoreProduct',
  // Undoing a Symmy link is a person's decision in the product editor; no key, job or agent sends it.
  'SetSymmyLink',
  'CreateCategory',
  'UpdateCategory',
  'DeleteCategory',
  'ConfigureStorefrontCatalog',
  // Market price lists and bulk market assortment change money and the whole offer of a market.
  'ConfigureMarket',
  'RemoveMarket',
  'SetMarketProductOffers',
  // AI level C: an agent may only propose; a person approves or reverts in the app.
  'AiDecideChanges',
  'AiRevertBatch',
]);
/** Commands only the source-catalog import Action runs; they write server-owned provenance, so no person sends them. */
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
export const AKROS_PLAYGROUND_LEGAL_ENTITY_ID = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
export const ESHOP_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000023';
export const isAkrosCompany = (id: string | undefined) =>
  id === AKROS_LEGAL_ENTITY_ID || id === AKROS_PLAYGROUND_LEGAL_ENTITY_ID;

/**
 * Whether Core admitted this caller as the registered Storefront BFF: through its active `demo.storefront-client`
 * workload binding, registered for this company (O73, D6). Pass the decision of a carrier whose one workload is the
 * storefront's (`recordsCarrier`, `placeStorefrontOrderCarrier`). People, MCP connections, agents and every other key
 * are admitted by their own grants instead, so neither the credential kind nor the company ever decides it.
 */
export const isStorefrontAdmission = (decision: Pick<AccessDecision, 'outcome' | 'reasons'>): boolean =>
  decision.outcome === 'ALLOWED' && decision.reasons.some(({ code }) => code === 'allow.workload');

/**
 * Wraps the apply-command handler: the guard runs before any state is loaded. The Storefront BFF needs no command
 * guard of its own: Core admits its workload only on `place-storefront-order`, whose payload is the guest order alone.
 */
export const withCommandGuard =
  <
    Payload extends { readonly command: { readonly _tag: string } },
    Context extends {
      readonly scope: Pick<TrustedPrincipalContext, 'authMethod' | 'delegatedByPrincipalId'>;
    },
    Success,
    Failure,
    Requirements,
  >(
    handler: (payload: Payload, context: Context) => Effect.Effect<Success, Failure, Requirements>,
  ) =>
  (payload: Payload, context: Context): Effect.Effect<Success, Failure | MerchandisePermissionDenied, Requirements> =>
    (Predicate.isTagged(payload.command, 'UpsertSourceProduct')
      ? Effect.fail(
          new MerchandisePermissionDenied({
            code: 'merchandise_permission_denied',
            reason: `Merchandise command ${payload.command._tag} is reserved for the source-catalog import`,
          }),
        )
      : assertCommandAllowed(
          principalKindOf(context.scope.authMethod, context.scope.delegatedByPrincipalId, payload.command._tag),
          payload.command._tag,
        )
    ).pipe(Effect.flatMap(() => handler(payload, context)));
