import { and, eq, gt, lte } from 'drizzle-orm';
import { Context, DateTime, Effect, Option, Predicate } from 'effect';
import { AssigneeIneligible } from './assignee-ineligible.ts';
import { AssignablePrincipalsUnavailable } from './assignable-principals-unavailable.ts';

import { CoreDatabase } from '../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../db/database-identities.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import { accessAgentConnections, accessScopes, principalCompanyMemberships, principals } from '../db/schema.ts';
import type { PrincipalStatus } from '../db/schema.ts';
import type { CompanyMembershipStatus } from '../permissions/company-membership.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { GateCarrier } from '../access/enforcement/contract.ts';
import type { AccessRecordTarget } from '../access/decision/contract.ts';
import { decideAccess, resolveListAccess } from '../access/decision/engine.ts';
import { capabilityPolicyOf } from '../access/enforcement/capability.ts';
import { shouldRecordDecision } from '../access/enforcement/decision-log.ts';
import type { AccessDecisionLogEntry } from '../access/enforcement/decision-log.ts';
import {
  AgentIdSchema,
  AgentConnectionIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../access/ids.ts';
import { AccessEnforcementPortsLive } from '../operations/access-gate.ts';
import type { AccessEnforcementPorts } from '../operations/access-gate.ts';
import type { ActorContext } from '../access/model.ts';
import type { PrincipalRef } from '../permissions/principal-ref.ts';

export { AssigneeIneligible } from './assignee-ineligible.ts';
export { AssignablePrincipalsUnavailable } from './assignable-principals-unavailable.ts';

export interface AssignmentCompanyScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export interface AssignablePrincipal {
  readonly displayName: string;
  readonly principalRef: PrincipalRef;
}

export interface AssignmentDirectoryMember extends AssignablePrincipal {
  readonly membershipStatus: CompanyMembershipStatus;
  readonly principalStatus: PrincipalStatus;
}

/** Core-owned SQL snapshot. Kind and affiliation are deliberately absent: neither grants rights. */
export interface AssignablePrincipalDirectory extends AssignmentCompanyScope {
  /** Complete real connection candidates, revalidated independently by the canonical engine. */
  readonly agentContexts?: readonly Extract<ActorContext, { readonly _tag: 'Agent' }>[];
  readonly members: readonly AssignmentDirectoryMember[];
}

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new AssignablePrincipalsUnavailable({ reason: 'Assignment authorization is unavailable' }),
    'cause',
    { enumerable: false, value: cause },
  );
const ineligible = () => new AssigneeIneligible({ reason: 'The target is not an eligible company principal' });

/** Runs inside the caller's trusted scoped transaction; performs no remote I/O. */
export const loadAssignablePrincipalDirectory = Effect.fn('Core.loadAssignablePrincipalDirectory')(
  function* loadAssignablePrincipalDirectory(transaction: ScopedTransactionExecutor, scope: OperationalScope) {
    const { legalEntityId } = scope;
    if (
      legalEntityId === undefined ||
      transaction.scope.tenantId !== scope.tenantId ||
      transaction.scope.legalEntityId !== legalEntityId
    ) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select({
        displayName: principals.displayName,
        membershipStatus: principalCompanyMemberships.status,
        principalId: principals.principalId,
        principalStatus: principals.status,
        tenantId: principals.tenantId,
      })
      .from(principalCompanyMemberships)
      .innerJoin(
        principals,
        and(
          eq(principals.tenantId, principalCompanyMemberships.tenantId),
          eq(principals.principalId, principalCompanyMemberships.principalId),
        ),
      )
      .where(
        and(
          eq(principalCompanyMemberships.tenantId, scope.tenantId),
          eq(principalCompanyMemberships.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(principals.displayName, principals.principalId)
      .pipe(Effect.mapError(unavailable));
    const now = yield* DateTime.nowAsDate;
    const connections = yield* transaction
      .select({
        agentId: accessAgentConnections.agentId,
        connectionId: accessAgentConnections.connectionId,
        principalId: accessAgentConnections.principalId,
        revision: accessAgentConnections.revision,
      })
      .from(accessAgentConnections)
      .innerJoin(
        accessScopes,
        and(
          eq(accessScopes.tenantId, accessAgentConnections.tenantId),
          eq(accessScopes.scopeId, accessAgentConnections.scopeId),
        ),
      )
      .where(
        and(
          eq(accessAgentConnections.tenantId, scope.tenantId),
          eq(accessScopes.legalEntityId, legalEntityId),
          eq(accessAgentConnections.status, 'active'),
          lte(accessAgentConnections.validFrom, now),
          gt(accessAgentConnections.validUntil, now),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    return {
      agentContexts: connections.map((row) => ({
        _tag: 'Agent' as const,
        agentId: AgentIdSchema.make(row.agentId),
        connectionId: AgentConnectionIdSchema.make(row.connectionId),
        consentRevision: row.revision,
        principalId: PrincipalIdSchema.make(row.principalId),
      })),
      legalEntityId,
      members: rows.map(({ displayName, membershipStatus, principalId, principalStatus, tenantId }) => ({
        displayName,
        membershipStatus,
        principalRef: { principalId, tenantId },
        principalStatus,
      })),
      tenantId: scope.tenantId,
    } satisfies AssignablePrincipalDirectory;
  },
);

/** Short Core-owned preflight transaction. The owner's callback receives read-only scoped SQL. */
export const loadAssignmentPreflightSnapshot = Effect.fn('Core.loadAssignmentPreflightSnapshot')(
  function* assignmentPreflightSnapshot<A, E>(
    scope: OperationalScope & AssignmentCompanyScope,
    loadOwner: (transaction: Pick<ScopedTransactionExecutor, 'select'>) => Effect.Effect<A, E>,
  ) {
    const database = yield* Effect.serviceOption(CoreDatabase);
    const enrollment = yield* Effect.serviceOption(DatabaseIdentityEnrollmentContext);
    if (Option.isNone(database) || Option.isNone(enrollment)) {
      return yield* unavailable();
    }
    return yield* database.value.executor
      .transaction(
        Effect.fn('Core.assignmentPreflightTransaction')(function* preflight(transaction) {
          const scoped = yield* installOperationalScope(transaction, scope, enrollment.value).pipe(
            Effect.mapError(unavailable),
          );
          return yield* Effect.all(
            {
              directory: loadAssignablePrincipalDirectory(scoped, scope),
              value: loadOwner({ select: scoped.select }),
            },
            { concurrency: 1 },
          );
        }),
      )
      .pipe(Effect.mapError(unavailable));
  },
);

/** Recheck this inside the write transaction after a pre-transaction permission check. */
export const activeAssignmentMember = (
  directory: AssignablePrincipalDirectory,
  principal: PrincipalRef,
): Effect.Effect<AssignablePrincipal, AssigneeIneligible> => {
  const member = directory.members.find(
    ({ principalRef }) =>
      principalRef.tenantId === directory.tenantId &&
      principalRef.tenantId === principal.tenantId &&
      principalRef.principalId === principal.principalId,
  );
  return member?.membershipStatus === 'active' && member.principalStatus === 'active'
    ? Effect.succeed({ displayName: member.displayName, principalRef: member.principalRef })
    : Effect.fail(ineligible());
};

/** The owner names an actual registered capability, not a legacy module permission. */
export interface AssignmentEligibility {
  readonly carrier: GateCarrier;
  readonly scope: OperationalScope;
  readonly target?: AccessRecordTarget;
}

const isActive = (directory: AssignablePrincipalDirectory, member: AssignmentDirectoryMember) =>
  member.principalRef.tenantId === directory.tenantId &&
  member.principalStatus === 'active' &&
  member.membershipStatus === 'active';

/**
 * Private subject query. The requester remains the authenticated evaluator and SQL scope. The
 * subject is only an engine ActorContextInput, never an OperationalScope or an execution token.
 */
export const makeAssignablePrincipals = (ports: AccessEnforcementPorts) => {
  const evaluate = Effect.fn('Core.assignmentEligibility')(function* evaluate(
    directory: AssignablePrincipalDirectory,
    principal: PrincipalRef,
    eligibility: AssignmentEligibility,
  ) {
    const { carrier, scope, target } = eligibility;
    const declaration = carrier.accessDeclaration;
    if (
      scope.tenantId !== directory.tenantId ||
      scope.legalEntityId !== directory.legalEntityId ||
      declaration?.kind !== 'read' ||
      carrier.accessActor !== undefined ||
      carrier.accessWorkload !== undefined
    ) {
      return yield* unavailable();
    }
    const principalId = PrincipalIdSchema.make(principal.principalId);
    const tenantId = TenantIdSchema.make(scope.tenantId);
    const legalEntityId = LegalEntityIdSchema.make(directory.legalEntityId);
    const kind = yield* ports.principalKinds
      .readKind({ principalId, scope, tenantId })
      .pipe(Effect.mapError(unavailable));
    if (Option.isNone(kind) || (kind.value !== 'human' && kind.value !== 'agent')) {
      return false;
    }
    const actors: readonly ActorContext[] =
      kind.value === 'human'
        ? [{ _tag: 'Principal', principalId }]
        : (directory.agentContexts ?? []).filter((context) => context.agentId === principal.principalId);
    const answers = yield* Effect.forEach(
      actors,
      Effect.fn('Core.assignmentSubjectContext')(function* evaluateContext(actor) {
        if (Predicate.isTagged(actor, 'Agent')) {
          const ownerKind = yield* ports.principalKinds
            .readKind({ principalId: actor.principalId, scope, tenantId })
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(ownerKind) || ownerKind.value !== 'human') {
            return false;
          }
        }
        const subject = { actor, legalEntityId, tenantId };
        const capability = capabilityPolicyOf(declaration);
        const authority = ports.intent.authorityFor(scope);
        const now = yield* DateTime.nowAsDate;
        const resolution =
          declaration.selectors.length > 0 && target === undefined
            ? yield* resolveListAccess(authority, ports.check, { actor: subject, capability, mode: 'run', now })
            : {
                decision: yield* decideAccess(authority, ports.check, {
                  actor: subject,
                  now,
                  request: target === undefined ? { capability, mode: 'run' } : { capability, mode: 'run', target },
                }),
              };
        const { decision } = resolution;
        if (decision.outcome === 'UNAVAILABLE') {
          return yield* unavailable();
        }
        if (shouldRecordDecision(decision, capability)) {
          const resolvedScope = yield* authority
            .readScope({
              holders: Predicate.isTagged(actor, 'Principal')
                ? [actor]
                : [
                    { _tag: 'Principal', principalId: actor.principalId },
                    { _tag: 'Agent', agentId: actor.agentId },
                  ],
              legalEntityId,
              tenantId,
            })
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(resolvedScope)) {
            return yield* unavailable();
          }
          const entry: AccessDecisionLogEntry = {
            actor,
            capability,
            decidedAt: now,
            mode: 'run',
            onBehalfOfPrincipalId: PrincipalIdSchema.make(scope.principalId),
            outcome: decision.outcome,
            reasons: decision.reasons,
            scope,
            scopeId: resolvedScope.value.scopeId,
          };
          const withTarget = target === undefined ? entry : { ...entry, target: target.recordKey };
          yield* ports.decisionLog
            .record(
              decision.admissionDeadline === undefined
                ? withTarget
                : { ...withTarget, admissionDeadline: decision.admissionDeadline },
            )
            .pipe(Effect.mapError(unavailable));
        }
        // ALLOWED list authority is eligibility even when this candidate owns no row yet. A missing
        // predicate is never silently widened to ALL; resolveListAccess supplies it only on proven reach.
        return (
          decision.outcome === 'ALLOWED' &&
          (declaration.selectors.length === 0 ||
            target !== undefined ||
            ('predicate' in resolution && resolution.predicate !== undefined))
        );
      }),
      { concurrency: 1 },
    );
    return answers.some(Boolean);
  });
  return {
    read: Effect.fn('Core.readAssignablePrincipals')(function* read(
      directory: AssignablePrincipalDirectory,
      eligibility: AssignmentEligibility,
    ) {
      const candidates = yield* Effect.forEach(
        directory.members.filter((member) => isActive(directory, member)),
        (member) =>
          evaluate(directory, member.principalRef, eligibility).pipe(
            Effect.map((allowed) =>
              allowed ? [{ displayName: member.displayName, principalRef: member.principalRef }] : [],
            ),
          ),
        { concurrency: 1 },
      );
      return candidates.flat();
    }),
    resolveAssignee: Effect.fn('Core.resolveAssignee')(function* resolve(
      directory: AssignablePrincipalDirectory,
      principal: PrincipalRef,
      eligibility: AssignmentEligibility,
    ) {
      const member = yield* activeAssignmentMember(directory, principal);
      if (!(yield* evaluate(directory, principal, eligibility))) {
        return yield* ineligible();
      }
      return member;
    }),
  };
};

export class AssignablePrincipals extends Context.Service<
  AssignablePrincipals,
  ReturnType<typeof makeAssignablePrincipals>
>()('@app/core-runtime/auth/assignable-principals/AssignablePrincipals') {}

const withGate = Effect.fn('Core.assignmentGate')(function* assignmentGate<A, E, R>(
  run: (service: ReturnType<typeof makeAssignablePrincipals>) => Effect.Effect<A, E, R>,
) {
  const injected = yield* Effect.serviceOption(AssignablePrincipals);
  if (Option.isSome(injected)) {
    return yield* run(injected.value);
  }
  return yield* run(makeAssignablePrincipals(yield* AccessEnforcementPortsLive));
});

export const readAssignablePrincipals = (directory: AssignablePrincipalDirectory, eligibility: AssignmentEligibility) =>
  withGate((service) => service.read(directory, eligibility));

export const resolveAssignee = (
  directory: AssignablePrincipalDirectory,
  principal: PrincipalRef,
  eligibility: AssignmentEligibility,
) => withGate((service) => service.resolveAssignee(directory, principal, eligibility));
