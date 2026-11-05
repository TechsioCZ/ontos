import { ContextAccess, humanPrincipalCandidatesForTransaction } from '@app/core-runtime';
import type { ActionServicePreparationContext, ContextAccessService } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { normalizeProjectPrefix } from '../../shared/domain/project.ts';

export const ProjectOwnerDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type ProjectOwnerDecision = typeof ProjectOwnerDecisionSchema.Type;
type OwnerCandidates = ReturnType<typeof humanPrincipalCandidatesForTransaction>;

/** Prefix is immutable and tenant-unique, so the authorization target exists before Create. */
export const projectOwnerEligibilityTarget = (prefix: string) => ({
  moduleId: 'projects.core',
  resourceId: normalizeProjectPrefix(prefix),
  resourceType: 'projects.project-owner-eligibility',
});

/**
 * The SpiceDB half of Owner eligibility. It is remote I/O, so it runs only outside a database transaction:
 * in an Action's service preparation or a read's finish step.
 */
export const makeProjectOwnerAuthorization = ({
  access,
  tenantId,
}: {
  readonly access: Pick<ContextAccessService, 'tenantResources'>;
  readonly tenantId: string;
}) =>
  Effect.fn('ProjectsOwnerEligibility.authorize')(function* authorizeProjectOwner(prefix: string, principalId: string) {
    if (access.tenantResources === undefined) {
      return 'unavailable' as const;
    }
    const target = projectOwnerEligibilityTarget(prefix);
    const results = yield* access.tenantResources({
      permission: 'assign',
      principalId,
      resources: [target],
      tenantId,
    });
    const expectedKey = `${target.moduleId}:${target.resourceType}:${target.resourceId}`;
    return results.length === 1 && results[0]?.key === expectedKey ? results[0].decision : ('unavailable' as const);
  });

export const projectOwnerAuthorization = (tenantId: string) =>
  ContextAccess.pipe(Effect.map((access) => makeProjectOwnerAuthorization({ access, tenantId })));

/** Only an active human principal of the tenant can be an Owner; anyone else is denied before authorization. */
const activeOwner = (principals: Pick<OwnerCandidates, 'find'>, principalId: string) =>
  principals.find(principalId).pipe(Effect.map((candidate) => candidate !== undefined));

export interface PreparedProjectOwnerDecision {
  readonly decision: ProjectOwnerDecision;
  readonly prefix: string;
  readonly principalId: string;
}

/** Decides one Owner before the business transaction: identity from a snapshot read, eligibility from SpiceDB. */
export const prepareProjectOwnerDecision = Effect.fn('ProjectsOwnerEligibility.prepare')(function* prepareOwner(
  context: ActionServicePreparationContext,
  prefix: string,
  principalId: string,
) {
  const normalized = normalizeProjectPrefix(prefix);
  const prepared = (decision: ProjectOwnerDecision): PreparedProjectOwnerDecision => ({
    decision,
    prefix: normalized,
    principalId,
  });
  const active = yield* context
    .transaction((transaction) => activeOwner(humanPrincipalCandidatesForTransaction(transaction), principalId))
    .pipe(
      Effect.map(Option.some),
      Effect.catchTag('PrincipalCandidatesUnavailable', () => Effect.succeedNone),
    );
  if (Option.isNone(active)) {
    return prepared('unavailable');
  }
  if (!active.value) {
    return prepared('denied');
  }
  const authorize = yield* projectOwnerAuthorization(context.scope.tenantId);
  return prepared(yield* authorize(normalized, principalId));
});

/**
 * The commit-transaction view of a prepared decision. It answers only the exact prepared Owner and prefix, and
 * rechecks inside the transaction that the Owner is still an active human principal.
 */
export const preparedProjectOwnerEligibility =
  (principals: Pick<OwnerCandidates, 'find'>, owner: Option.Option<PreparedProjectOwnerDecision>) =>
  (prefix: string, principalId: string): Effect.Effect<ProjectOwnerDecision> => {
    if (
      Option.isNone(owner) ||
      owner.value.prefix !== normalizeProjectPrefix(prefix) ||
      owner.value.principalId !== principalId
    ) {
      return Effect.succeed('unavailable');
    }
    const prepared = owner.value;
    if (prepared.decision !== 'allowed') {
      return Effect.succeed(prepared.decision);
    }
    return activeOwner(principals, principalId).pipe(
      Effect.map((active): ProjectOwnerDecision => (active ? 'allowed' : 'denied')),
      Effect.catchTag('PrincipalCandidatesUnavailable', () => Effect.succeed('unavailable' as const)),
    );
  };
