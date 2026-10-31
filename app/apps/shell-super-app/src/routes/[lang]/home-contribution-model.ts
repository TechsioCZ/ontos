import { Effect, Match, Schema } from 'effect';
import { ResolveModuleTargetPayloadSchema } from '../../../shared/api.ts';
import type { ResolvedModuleTarget, ShellHomeComponent } from '../../../shared/api.ts';
import { resolveModuleTarget } from '../../api/auth-client.ts';
import type { ShellAuthenticationClientOptions } from '../../api/auth-client.ts';

export type HomeContribution =
  | { readonly state: 'ready'; readonly target: ResolvedModuleTarget }
  | { readonly state: 'forbidden' | 'unavailable' };

const resolveCandidate = (
  candidate: ShellHomeComponent,
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

const HOME_PATH = /^\/(?:[a-z]{2}\/?)?$/u;

export const isHomeRequest = (request: Request): boolean => HOME_PATH.test(new URL(request.url).pathname);

/**
 * The Home components a document's Home may show, lowest order first: a candidate is offered only when every module
 * whose data it shows is in the persona's navigation, so roles without them never cause a denied (403) request.
 * Nothing on any page other than Home.
 */
export const homeContributionCandidates = (
  request: Request,
  homeComponents: readonly ShellHomeComponent[],
  navigationModuleIds: ReadonlySet<string>,
): readonly ShellHomeComponent[] | undefined =>
  isHomeRequest(request)
    ? homeComponents.filter(({ requiresModules }) =>
        requiresModules.every((moduleId) => navigationModuleIds.has(moduleId)),
      )
    : undefined;

/**
 * Resolve the Home summary afresh, independent of cached navigation permission hints. A missing or denied candidate
 * falls through to the next one, and the shell shows its own welcome page when none applies.
 */
export const resolveHomeContribution = (
  candidates: readonly ShellHomeComponent[],
  compositionRevision: string,
  options: ShellAuthenticationClientOptions,
): Effect.Effect<HomeContribution> => {
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
  return tryFrom(0);
};
