import { Effect, Match, Schema } from 'effect';
import type { Option } from 'effect';
import { ResolveModuleTargetPayloadSchema } from '../../../shared/api.ts';
import type { ResolvedModuleTarget } from '../../../shared/api.ts';
import { resolveModuleTarget } from '../../api/auth-client.ts';
import type { ShellAuthenticationClientOptions } from '../../api/auth-client.ts';

export type HomeContribution =
  | { readonly state: 'ready'; readonly target: ResolvedModuleTarget }
  | { readonly state: 'forbidden' | 'unavailable' };

/**
 * Per-company Home components, most specific first. A candidate is requested only when its module is in the
 * persona's navigation, so roles without it never cause a denied (403) request; a missing or denied candidate falls
 * through to the next one, and the shell shows its own welcome page when none applies.
 */
const homeComponentCandidates = [
  // Prefer the CRM's own data over a generic sales dashboard for Hanák's managers.
  { entrypointKey: 'demo.crm.component.home-summary', moduleId: 'demo.crm' },
  { entrypointKey: 'demo.sales-insights.component.crm-dashboard', moduleId: 'demo.sales-insights' },
] as const;

const resolveCandidate = (
  candidate: (typeof homeComponentCandidates)[number],
  compositionRevision: string,
  options: ShellAuthenticationClientOptions,
): Effect.Effect<HomeContribution> =>
  Schema.decodeEffect(ResolveModuleTargetPayloadSchema)({
    compositionRevision,
    entrypointKey: candidate.entrypointKey,
    moduleId: candidate.moduleId,
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
  );

/** Resolve the exact declared Home component afresh, independent of cached navigation permission hints. */
export const loadHomeContribution = (
  request: Request,
  compositionRevision: string,
  options: ShellAuthenticationClientOptions,
  navigationModuleIds: ReadonlySet<string>,
): Effect.Effect<Option.Option<HomeContribution>> => {
  if (!/^\/(?:[a-z]{2}\/?)?$/u.test(new URL(request.url).pathname)) {
    return Effect.succeedNone;
  }
  const candidates = homeComponentCandidates.filter(({ moduleId }) => navigationModuleIds.has(moduleId));
  const tryFrom = (index: number): Effect.Effect<HomeContribution> => {
    const candidate = candidates[index];
    if (candidate === undefined) {
      return Effect.succeed({ state: 'forbidden' as const });
    }
    return resolveCandidate(candidate, compositionRevision, options).pipe(
      Effect.filterOrElse(
        (contribution) => contribution.state !== 'forbidden',
        () => tryFrom(index + 1),
      ),
    );
  };
  return tryFrom(0).pipe(Effect.asSome);
};
