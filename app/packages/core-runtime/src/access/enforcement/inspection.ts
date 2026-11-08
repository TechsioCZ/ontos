import { DateTime, Effect, Option, Schema } from 'effect';

import { readVerifiedGatewayCompositionRevision } from '../../auth/system-principal-context-provenance.ts';
import type { LegalEntityId } from '../ids.ts';
import type { DeclaredActionAuthority } from '../../permissions/action-authority.ts';
import { isCompanyAffiliationValid } from '../../permissions/company-membership.ts';
import { legalEntityObjectId, objectTypeOf } from '../compiler/object-id.ts';
import { resolveActorContext } from '../decision/authority.ts';
import type { ActorContextInput, ResolvedActor } from '../decision/authority.ts';
import type { AccessDecision, DecisionCapabilityPolicy } from '../decision/contract.ts';
import { decideAccess, resolveListAccess } from '../decision/engine.ts';
import { withOptional } from '../decision/optional.ts';
import { AgentConnectionIdSchema, AgentIdSchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type { AccessMode, ActorContext } from '../model.ts';
import type { AccessPrincipalKinds } from './actor.ts';
import { capabilityPolicyOf, gateScopeOf } from './capability.ts';
import type { AccessDecisionPorts } from './contract.ts';
import { shouldRecordDecision } from './decision-log.ts';
import type { AccessDecisionLogWriter } from './decision-log.ts';
import { seamDenial, seamRefusal } from './decisions.ts';
import { SubjectInspectionUnavailable } from './inspection-contract.ts';
import type {
  SubjectAccessInspectionService,
  SubjectCapabilityInspectionInput,
  SubjectInspectionInput,
  SubjectListInspection,
} from './inspection-contract.ts';
import type { SubjectIdentityFactsSource } from './inspection-facts.ts';

export interface SubjectInspectionCatalog {
  readonly actions: ReadonlyMap<string, DeclaredActionAuthority>;
  readonly revision: string;
}

export interface SubjectInspectionPorts {
  readonly authorityFor: AccessDecisionPorts['authorityFor'];
  readonly check: AccessDecisionPorts['check'];
  /** Revalidated per call and after evaluation, never a retained Action catalog. */
  readonly currentCatalog: Effect.Effect<SubjectInspectionCatalog, SubjectInspectionUnavailable>;
  readonly decisionLog: AccessDecisionLogWriter;
  readonly identities: SubjectIdentityFactsSource;
  readonly principalKinds: AccessPrincipalKinds;
}

const subjectId = Schema.decodeUnknownOption(PrincipalIdSchema);
const subjectTenant = Schema.decodeUnknownOption(TenantIdSchema);
const agentContextSchema = Schema.Struct({
  connectionId: AgentConnectionIdSchema,
  consentRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  principalId: PrincipalIdSchema,
});
const agentContext = Schema.decodeUnknownOption(agentContextSchema);
const unavailable = (cause?: unknown) =>
  new SubjectInspectionUnavailable({ cause, reason: 'Subject inspection is unavailable' });

const SCOPE_MISMATCH = 'deny.scope_mismatch';
const PRINCIPAL_FORBIDDEN = 'deny.principal_kind_forbidden';

interface InspectionActor {
  readonly actor?: ActorContextInput;
  readonly decision?: AccessDecision;
}

/** No OperationalScope is constructed here. The subject is only a canonical engine actor. */
export const makeSubjectAccessInspection = (ports: SubjectInspectionPorts): SubjectAccessInspectionService => {
  const current = Effect.fn('SubjectInspection.current')(function* current(input: SubjectInspectionInput) {
    const { queryScope, requesterScope } = input;
    if (
      queryScope === undefined ||
      queryScope.tenantId !== requesterScope.tenantId ||
      queryScope.legalEntityId !== requesterScope.legalEntityId
    ) {
      return yield* unavailable('Inspection query scope differs from the authenticated requester scope');
    }
    const catalog = yield* ports.currentCatalog;
    const revision = readVerifiedGatewayCompositionRevision(input.requesterScope);
    if (revision !== undefined && revision !== catalog.revision) {
      return yield* unavailable('Requester composition is no longer current');
    }
    return catalog;
  });

  const kindAndIdentity = Effect.fn('SubjectInspection.kindAndIdentity')(function* kindAndIdentity(
    input: SubjectInspectionInput,
    principalId: typeof PrincipalIdSchema.Type,
    legalEntityId?: string,
  ) {
    const scope = input.requesterScope;
    const { facts, kind } = yield* Effect.all(
      {
        facts: ports.identities.read(
          withOptional({ principalId, requesterScope: scope }, 'legalEntityId', legalEntityId),
        ),
        kind: ports.principalKinds
          .readKind({ principalId, scope, tenantId: TenantIdSchema.make(scope.tenantId) })
          .pipe(Effect.mapError(unavailable)),
      },
      { concurrency: 1 },
    );
    if (Option.isNone(kind) || Option.isNone(facts)) {
      return Option.none();
    }
    const identity = facts.value;
    if (
      identity.principalStatus !== 'active' ||
      identity.tenantStatus !== 'active' ||
      (legalEntityId !== undefined && identity.companyStatus !== 'active')
    ) {
      return Option.none();
    }
    if (
      identity.membership !== undefined &&
      (identity.membership.status !== 'active' ||
        !isCompanyAffiliationValid(kind.value, identity.membership.affiliation))
    ) {
      return Option.none();
    }
    return kind;
  });

  const actorFor = Effect.fn('SubjectInspection.actor')(function* actorFor(
    input: SubjectInspectionInput,
    legalEntityId?: LegalEntityId,
  ): Effect.fn.Return<InspectionActor, SubjectInspectionUnavailable> {
    const principalId = subjectId(input.subject.principalId);
    const tenantId = subjectTenant(input.subject.tenantId);
    if (
      Option.isNone(principalId) ||
      Option.isNone(tenantId) ||
      input.subject.tenantId !== input.requesterScope.tenantId
    ) {
      return { decision: seamRefusal(SCOPE_MISMATCH) };
    }
    const kind = yield* kindAndIdentity(input, principalId.value, legalEntityId);
    if (Option.isNone(kind)) {
      return { decision: seamRefusal(PRINCIPAL_FORBIDDEN) };
    }
    if (kind.value !== 'human' && kind.value !== 'agent') {
      return { decision: seamRefusal('deny.workload_forbidden') };
    }
    let actor: ActorContext;
    if (kind.value === 'human') {
      if (input.subject.agentContext !== undefined) {
        return { decision: seamRefusal(PRINCIPAL_FORBIDDEN) };
      }
      actor = { _tag: 'Principal', principalId: principalId.value };
    } else {
      // The caller must carry ONE actual credential-bound consent context. Searching all connections,
      // borrowing requester consent, or interpreting an OAuth grant id as a connection is forbidden.
      const context = agentContext(input.subject.agentContext);
      if (Option.isNone(context)) {
        return yield* unavailable(
          'Agent inspection requires its exact credential-bound connection and consent revision',
        );
      }
      const ownerKind = yield* kindAndIdentity(input, context.value.principalId, legalEntityId);
      if (Option.isNone(ownerKind) || ownerKind.value !== 'human') {
        return { decision: seamRefusal('deny.actor_subject_invalid') };
      }
      actor = { _tag: 'Agent', agentId: AgentIdSchema.make(principalId.value), ...context.value };
    }
    return { actor: withOptional({ actor, tenantId: tenantId.value }, 'legalEntityId', legalEntityId) };
  });

  const resolve = Effect.fn('SubjectInspection.resolve')(function* resolve(
    input: SubjectInspectionInput,
    legalEntityId?: LegalEntityId,
  ) {
    const selected = yield* actorFor(input, legalEntityId);
    const authority = ports.authorityFor(input.requesterScope);
    if (selected.actor === undefined) {
      return { authority, decision: selected.decision ?? seamRefusal(PRINCIPAL_FORBIDDEN) };
    }
    const now = yield* DateTime.nowAsDate;
    const resolution = yield* resolveActorContext(authority, selected.actor, now);
    if (resolution.unavailable !== undefined) {
      return yield* unavailable();
    }
    if (resolution.resolved === undefined) {
      const [first, ...rest] = resolution.refusal ?? [{ code: SCOPE_MISMATCH }];
      return { authority, decision: seamDenial(first ?? { code: SCOPE_MISMATCH }, ...rest) };
    }
    return { actor: selected.actor, authority, now, resolved: resolution.resolved };
  });

  const record = Effect.fn('SubjectInspection.record')(function* record(input: {
    readonly capability: DecisionCapabilityPolicy;
    readonly decision: AccessDecision;
    readonly mode: AccessMode;
    readonly now: Date;
    readonly question: SubjectCapabilityInspectionInput;
    readonly resolved: ResolvedActor;
  }) {
    if (input.decision.outcome === 'UNAVAILABLE') {
      return yield* unavailable(input.decision.reasons);
    }
    if (shouldRecordDecision(input.decision, input.capability)) {
      yield* ports.decisionLog
        .record(
          withOptional(
            withOptional(
              {
                actor: input.resolved.actor,
                capability: input.capability,
                decidedAt: input.now,
                mode: input.mode,
                onBehalfOfPrincipalId: PrincipalIdSchema.make(input.question.requesterScope.principalId),
                outcome: input.decision.outcome,
                reasons: input.decision.reasons,
                scope: input.question.requesterScope,
                scopeId: input.resolved.scope.scopeId,
              },
              'target',
              input.question.target?.recordKey,
            ),
            'admissionDeadline',
            input.decision.admissionDeadline,
          ),
        )
        .pipe(Effect.mapError(unavailable));
    }
    return input.decision;
  });

  const evaluate = Effect.fn('SubjectInspection.evaluate')(function* evaluate(
    input: SubjectCapabilityInspectionInput,
    listing: boolean,
  ) {
    const { carrier } = input;
    // These are direct SUBJECT projections, not delegated calls. Module-only identity/workload
    // purposes have no human capability and inspection cannot manufacture the gateway's act proof.
    if (carrier.accessActor?.subject === 'workload' || carrier.accessDeclaration === undefined) {
      return {
        decision: seamRefusal(
          carrier.accessWorkload !== undefined || carrier.accessActor?.subject === 'workload'
            ? 'deny.workload_only'
            : 'deny.declaration_missing',
        ),
      };
    }
    const scope = gateScopeOf(input.legalEntityScope, input.requesterScope);
    if (scope.refusal !== undefined) {
      return { decision: seamDenial(scope.refusal) };
    }
    const prepared = yield* resolve(input, scope.legalEntityId);
    if (prepared.resolved === undefined || prepared.actor === undefined) {
      return { decision: prepared.decision ?? seamRefusal(SCOPE_MISMATCH) };
    }
    const capability = capabilityPolicyOf(carrier.accessDeclaration);
    // LIST has no containing-record/parent-read input. Field decisions must use inspect with their
    // canonical parentRead, never the list engine's intentionally narrower read contract.
    if (listing && capability.kind !== 'read') {
      return { decision: seamRefusal('deny.mode_unsupported') };
    }
    const mode = input.mode ?? 'run';
    const result = listing
      ? yield* resolveListAccess(prepared.authority, ports.check, {
          actor: prepared.actor,
          capability,
          mode,
          now: prepared.now,
        })
      : {
          decision: yield* decideAccess(prepared.authority, ports.check, {
            actor: prepared.actor,
            now: prepared.now,
            request: withOptional(
              withOptional(withOptional({ capability, mode }, 'amount', input.amount), 'target', input.target),
              'parentRead',
              input.parentRead,
            ),
          }),
        };
    const decision = yield* record({ ...prepared, capability, decision: result.decision, mode, question: input });
    if (listing && decision.outcome === 'ALLOWED' && (!('predicate' in result) || result.predicate === undefined)) {
      return yield* unavailable('An allowed LIST inspection has no predicate');
    }
    return result;
  });

  const checked = Effect.fn('SubjectInspection.checked')(function* checked<A>(
    input: SubjectInspectionInput,
    body: (catalog: SubjectInspectionCatalog) => Effect.Effect<A, SubjectInspectionUnavailable>,
  ) {
    const before = yield* current(input);
    return yield* body(before).pipe(
      Effect.tap(() =>
        current(input).pipe(
          Effect.flatMap((after) =>
            after.revision === before.revision
              ? Effect.void
              : Effect.fail(unavailable('Composition changed during subject inspection')),
          ),
        ),
      ),
    );
  });

  const inspectScope = Effect.fn('SubjectInspection.scope')(function* inspectScope(input: SubjectInspectionInput) {
    const selected = gateScopeOf(
      input.requesterScope.legalEntityId === undefined ? 'optional' : 'required',
      input.requesterScope,
    );
    const prepared = yield* resolve(input, selected.legalEntityId);
    if (prepared.resolved === undefined || prepared.actor === undefined) {
      return {
        decision: 'denied' as const,
        inspectionOnly: true as const,
        reasonCodes: prepared.decision?.reasons.map(({ code }) => code) ?? [SCOPE_MISMATCH],
      };
    }
    // A human selects their company through the canonical select relation. Agents do not select
    // companies independently of their exact persisted connection, already checked by resolve.
    if (selected.legalEntityId !== undefined) {
      const principal = prepared.actor.actor;
      const checks = yield* ports.check
        .checkBulk([
          {
            permission: 'select',
            resource: {
              id: legalEntityObjectId(input.requesterScope.tenantId, selected.legalEntityId),
              type: objectTypeOf('legal_entity'),
            },
            subject: { id: principal.principalId, type: 'principal' },
          },
        ])
        .pipe(Effect.mapError(unavailable));
      const [answer] = checks;
      if (
        checks.length !== 1 ||
        answer === undefined ||
        answer.permissionship === 'error' ||
        answer.permissionship === 'conditional'
      ) {
        return yield* unavailable('Company selection inspection was indeterminate');
      }
      if (answer.permissionship !== 'has') {
        return {
          decision: 'denied' as const,
          inspectionOnly: true as const,
          reasonCodes: [SCOPE_MISMATCH],
        };
      }
    }
    return {
      decision: 'allowed' as const,
      inspectionOnly: true as const,
      reasonCodes: ['allow.granted'],
    };
  });
  const inspectAction = Effect.fn('SubjectInspection.action')(function* inspectAction(
    input: SubjectInspectionInput,
    catalog: SubjectInspectionCatalog,
    actionKey: string,
  ) {
    const authority = catalog.actions.get(actionKey);
    const question = {
      carrier: authority?.carrier ?? {},
      legalEntityScope: authority?.legalEntityScope ?? 'optional',
      queryScope: input.queryScope,
      requesterScope: input.requesterScope,
      subject: input.subject,
    };
    const { propose, run } = yield* Effect.all(
      {
        propose: evaluate({ ...question, mode: 'propose' }, false),
        run: evaluate({ ...question, mode: 'run' }, false),
      },
      { concurrency: 1 },
    );
    return {
      actionKey,
      propose: propose.decision.outcome === 'ALLOWED' ? ('allowed' as const) : ('denied' as const),
      run: run.decision.outcome === 'ALLOWED' ? ('allowed' as const) : ('denied' as const),
    };
  });
  const inspectActions = Effect.fn('SubjectInspection.actions')(function* inspectActions(
    input: SubjectInspectionInput & { readonly actionKeys: readonly string[] },
    catalog: SubjectInspectionCatalog,
  ) {
    const authorities = yield* Effect.forEach(
      input.actionKeys,
      (actionKey) => inspectAction(input, catalog, actionKey),
      { concurrency: 1 },
    );
    return { authorities, inspectionOnly: true as const };
  });

  return Object.freeze<SubjectAccessInspectionService>({
    actions: (input) => checked(input, (catalog) => inspectActions(input, catalog)),
    inspect: (input) =>
      checked(input, () =>
        evaluate(input, false).pipe(Effect.map(({ decision }) => ({ decision, inspectionOnly: true as const }))),
      ),
    list: (input) =>
      checked(input, () =>
        evaluate(input, true).pipe(
          Effect.map((result): SubjectListInspection => ({ inspectionOnly: true, ...result })),
        ),
      ),

    scope: (input) => checked(input, () => inspectScope(input)),
  });
};
