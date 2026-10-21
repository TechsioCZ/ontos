// Sales-demo command guard (plan 22). One `apply-command` executor grant covers every command of the module, so
// this pure guard narrows what non-human principals (the agent bot's managed API key) may run.
import { Effect, Schema } from 'effect';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { CrmPermissionDenied } from '../errors/crm-permission-denied.ts';

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
export { nonHumanForbiddenCrmCommands as nonHumanForbiddenCommands } from '../commands/index.ts';
import {
  nonHumanAllowedCrmCommands,
  nonHumanForbiddenCrmCommands as nonHumanForbiddenCommands,
} from '../commands/index.ts';
/**
 * AI level C (ai-level-c lane): API keys (AI agents) may run only the allow-listed proposal command; every other
 * CRM change needs a person. The forbidden list stays as the explicit human-only marker.
 */
const forbidsCommand = (commandTag: string): boolean =>
  nonHumanForbiddenCommands.has(commandTag) || !nonHumanAllowedCrmCommands.has(commandTag);

export const assertCommandAllowed = (
  principalKind: PrincipalKind,
  commandTag: string,
): Effect.Effect<void, CrmPermissionDenied> =>
  principalKind === 'human' || !forbidsCommand(commandTag)
    ? Effect.void
    : Effect.fail(
        new CrmPermissionDenied({
          code: 'crm_permission_denied',
          reason: `Příkaz ${commandTag} smí v CRM provést jen člověk; AI agent může změny pouze navrhnout (AiProposeChanges).`,
        }),
      );

/** Wraps the apply-command handler: the guard runs before any state is loaded. */
export const withCommandGuard =
  <
    Payload extends { readonly command: { readonly _tag: string } },
    Context extends { readonly scope: Pick<TrustedPrincipalContext, 'authMethod' | 'delegatedByPrincipalId'> },
    Success,
    Failure,
    Requirements,
  >(
    handler: (payload: Payload, context: Context) => Effect.Effect<Success, Failure, Requirements>,
  ) =>
  (payload: Payload, context: Context): Effect.Effect<Success, Failure | CrmPermissionDenied, Requirements> =>
    assertCommandAllowed(principalKindOf(context.scope.authMethod, context.scope.delegatedByPrincipalId, payload.command._tag), payload.command._tag).pipe(
      Effect.flatMap(() => handler(payload, context)),
    );
