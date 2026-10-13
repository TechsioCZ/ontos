// Sales-demo command guard (plan 22). One `apply-command` executor grant covers every command of the module, so
// this pure guard narrows what non-human principals (the agent bot's managed API key) may run.
import { Effect, Schema } from 'effect';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { WorkPermissionDenied } from '../errors/work-permission-denied.ts';

export const PrincipalKindSchema = Schema.Literals(['human', 'non_human']);
export type PrincipalKind = typeof PrincipalKindSchema.Type;

/** Interactive sessions (also support impersonation) are human; API keys and system jobs are not. */
export const principalKindOf = (authMethod: TrustedPrincipalContext['authMethod']): PrincipalKind =>
  authMethod === 'session' || authMethod === 'support_impersonation' ? 'human' : 'non_human';

/** Commands reserved for human users; non-human principals (API keys, system jobs) are rejected. */
export const nonHumanForbiddenCommands: ReadonlySet<string> = new Set(['DeleteTask']);
const forbidsCommand = (commandTag: string): boolean => nonHumanForbiddenCommands.has(commandTag);

export const assertCommandAllowed = (
  principalKind: PrincipalKind,
  commandTag: string,
): Effect.Effect<void, WorkPermissionDenied> =>
  principalKind === 'human' || !forbidsCommand(commandTag)
    ? Effect.void
    : Effect.fail(
        new WorkPermissionDenied({
          code: 'work_permission_denied',
          reason: `Work command ${commandTag} is reserved for human users`,
        }),
      );

/** Wraps the apply-command handler: the guard runs before any state is loaded. */
export const withCommandGuard =
  <
    Payload extends { readonly command: { readonly _tag: string } },
    Context extends { readonly scope: Pick<TrustedPrincipalContext, 'authMethod'> },
    Success,
    Failure,
    Requirements,
  >(
    handler: (payload: Payload, context: Context) => Effect.Effect<Success, Failure, Requirements>,
  ) =>
  (payload: Payload, context: Context): Effect.Effect<Success, Failure | WorkPermissionDenied, Requirements> =>
    assertCommandAllowed(principalKindOf(context.scope.authMethod), payload.command._tag).pipe(
      Effect.flatMap(() => handler(payload, context)),
    );
