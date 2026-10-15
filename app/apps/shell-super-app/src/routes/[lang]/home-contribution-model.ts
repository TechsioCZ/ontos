import { Effect, Match, Schema } from 'effect';
import type { Option } from 'effect';
import { ResolveModuleTargetPayloadSchema } from '../../../shared/api.ts';
import type { ResolvedModuleTarget } from '../../../shared/api.ts';
import { resolveModuleTarget } from '../../api/auth-client.ts';
import type { ShellAuthenticationClientOptions } from '../../api/auth-client.ts';

export type HomeContribution =
  | { readonly state: 'ready'; readonly target: ResolvedModuleTarget }
  | { readonly state: 'forbidden' | 'unavailable' };

/** Resolve the exact declared Home component afresh, independent of cached navigation permission hints. */
export const loadHomeContribution = (
  request: Request,
  compositionRevision: string,
  options: ShellAuthenticationClientOptions,
): Effect.Effect<Option.Option<HomeContribution>> => {
  if (!/^\/(?:[a-z]{2}\/?)?$/u.test(new URL(request.url).pathname)) {
    return Effect.succeedNone;
  }
  return Schema.decodeEffect(ResolveModuleTargetPayloadSchema)({
    compositionRevision,
    entrypointKey: 'demo.sales-insights.component.crm-dashboard',
    moduleId: 'demo.sales-insights',
  }).pipe(
    Effect.flatMap((payload) => resolveModuleTarget(payload, options)),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed(
          Match.value(error).pipe(
            Match.tag('ShellTargetForbiddenProblem', 'ShellTargetNotFoundProblem', () => ({
              state: 'forbidden' as const,
            })),
            Match.tag(
              'ShellReloadRequiredProblem',
              'ShellAuthenticationRequiredProblem',
              'ShellSelectionRequiredProblem',
              'HttpClientError',
              'SchemaError',
              'ShellCapabilityUnavailableProblem',
              'ShellInternalProblem',
              'ShellInvalidRequestProblem',
              'ShellPolicyConflictProblem',
              'ShellPolicyUnprocessableProblem',
              'ShellPreconditionRequiredProblem',
              'ShellRateLimitedProblem',
              () => ({ state: 'unavailable' as const }),
            ),
            Match.exhaustive,
          ),
        ),
      onSuccess: (target) => Effect.succeed({ state: 'ready' as const, target }),
    }),
    Effect.asSome,
  );
};
