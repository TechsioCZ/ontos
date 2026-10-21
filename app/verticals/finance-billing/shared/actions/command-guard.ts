// Sales-demo command guard (plan 22). One `apply-command` executor grant covers every command of the module, so
// this pure guard narrows what non-human principals (the agent bot's managed API key) may run.
import { Effect, Schema } from 'effect';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import { FinanceRejected } from './errors/finance-rejected.ts';

export const PrincipalKindSchema = Schema.Literals(['human', 'non_human']);
export type PrincipalKind = typeof PrincipalKindSchema.Type;

/** Interactive sessions (also support impersonation) are human; API keys and system jobs are not. */
export const principalKindOf = (authMethod: TrustedPrincipalContext['authMethod']): PrincipalKind =>
  authMethod === 'session' || authMethod === 'support_impersonation' ? 'human' : 'non_human';

/** Billing is human-only: every command (drafts, confirm, void, accounting and payment observations) is rejected for non-human principals. */
const forbidsCommand = (_commandTag: string): boolean => true;

export const assertCommandAllowed = (
  principalKind: PrincipalKind,
  commandTag: string,
): Effect.Effect<void, FinanceRejected> =>
  principalKind === 'human' || !forbidsCommand(commandTag)
    ? Effect.void
    : Effect.fail(
        new FinanceRejected({
          code: 'finance_rejected',
          reason: `Billing command ${commandTag} is reserved for human users`,
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
  (payload: Payload, context: Context): Effect.Effect<Success, Failure | FinanceRejected, Requirements> =>
    assertCommandAllowed(principalKindOf(context.scope.authMethod), payload.command._tag).pipe(
      Effect.flatMap(() => handler(payload, context)),
    );
