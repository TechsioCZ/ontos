import { DateTime, Effect, Option, Schema } from 'effect';

import { readVerifiedGatewayCompositionRevision } from '../../auth/system-principal-context-provenance.ts';
import type { LegalEntityId } from '../ids.ts';
import type { DeclaredActionAuthority } from '../../permissions/action-authority.ts';
import { isCompanyAffiliationValid } from '../../permissions/company-membership.ts';
import { legalEntityObjectId, objectTypeOf } from '../compiler/object-id.ts';
import { resolveActorContext } from '../decision/authority.ts';
import type {
  ActorContextInput,
  AuthorityCellQuery,
  DecisionAuthorityPort,
  ResolvedActor,
  ScopeQuery,
} from '../decision/authority.ts';
import type { AccessDecision, DecisionCapabilityPolicy } from '../decision/contract.ts';
import { decideAccessMany, resolveListAccess } from '../decision/engine.ts';
import { withOptional } from '../decision/optional.ts';
import { holderIdOf } from '../decision/selector.ts';
import { AgentConnectionIdSchema, AgentIdSchema, PrincipalIdSchema, TenantIdSchema } from '../ids.ts';
import type { AccessMode, ActorContext } from '../model.ts';
import type { AccessPrincipalKinds } from './actor.ts';
import { capabilityPolicyOf, gateScopeOf } from './capability.ts';
import type { AccessDecisionPorts } from './contract.ts';
import { shouldRecordDecision } from './decision-log.ts';
import type { AccessDecisionLogBatchWriter } from './decision-log-batch.ts';
import type { AccessDecisionLogEntry } from './decision-log.ts';
import { seamDenial, seamRefusal } from './decisions.ts';
import { SubjectInspectionUnavailable } from './inspection-contract.ts';
import type {
  SubjectAccessInspectionService,
  SubjectCapabilityAnswer,
  SubjectCapabilityInspectionInput,
  SubjectCapabilityQuestion,
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
  /** Every row of one inspection is written in one transaction. */
  readonly decisionLog: AccessDecisionLogBatchWriter;
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

/** A batch question before resolution: its seam answer, or the context and capability it is decided in. */
type StagedQuestion =
  | { readonly answer: SubjectCapabilityAnswer; readonly legalEntityId?: undefined }
  | {
      readonly answer?: undefined;
      readonly capability: DecisionCapabilityPolicy;
      readonly legalEntityId?: LegalEntityId;
      readonly listing: boolean;
      readonly question: SubjectCapabilityInspectionInput;
    };

/** Where a batch question's answer comes from: already known before the engine, or the engine's answer at an index. */
type AnswerSlot =
  | { readonly answer: SubjectCapabilityAnswer; readonly pending?: undefined }
  | { readonly answer?: undefined; readonly pending: number };

/** A batch question that reaches the engine, with everything its decision and its evidence row need. */
interface PendingQuestion {
  readonly actor: ActorContextInput;
  readonly authority: DecisionAuthorityPort;
  readonly capability: DecisionCapabilityPolicy;
  readonly listing: boolean;
  readonly mode: AccessMode;
  readonly now: Date;
  readonly question: SubjectCapabilityInspectionInput;
  readonly resolved: ResolvedActor;
}

/** One read per distinct query within one batch; a failed read stays failed for the whole batch. */
const onceEach = <Query, Value, Failure>(
  keyOf: (query: Query) => string,
  read: (query: Query) => Effect.Effect<Value, Failure>,
): ((query: Query) => Effect.Effect<Value, Failure>) => {
  const reads = new Map<string, Effect.Effect<Value, Failure>>();
  return (query) =>
    Effect.suspend(() => {
      const key = keyOf(query);
      const known = reads.get(key);
      if (known !== undefined) {
        return known;
      }
      return Effect.cached(read(query)).pipe(
        Effect.flatMap((once) => {
          reads.set(key, once);
          return once;
        }),
      );
    });
};

const scopeQueryKey = (query: ScopeQuery): string =>
  [query.tenantId, query.legalEntityId ?? '', ...query.holders.map(holderIdOf)].join('\u0000');

/**
 * The intent port of ONE batch: the same port, but a question its questions share — the scope, the cells of one
 * holder, capability and mode, the configure bases at one instant — is read once instead of once per question. Only
 * for the batch it is made for, never across requests; the agent connection and team reads stay fresh per call.
 */
const batchAuthorityOf = (authority: DecisionAuthorityPort): DecisionAuthorityPort =>
  withOptional(
    withOptional(
      {
        readCells: onceEach(
          (query: AuthorityCellQuery) =>
            [query.tenantId, query.scopeId, holderIdOf(query.holder), query.capabilityKey, query.mode].join('\u0000'),
          authority.readCells,
        ),
        readConnection: authority.readConnection,
        readScope: onceEach(scopeQueryKey, authority.readScope),
        readTeamIds: authority.readTeamIds,
      },
      // The engine reads one batch's cell sets in one call; each set is still read once per batch.
      'readCellsMany',
      authority.readCellsMany,
    ),
    'readConfigureBases',
    authority.readConfigureBases === undefined
      ? undefined
      : onceEach(
          (query: { readonly actor: string; readonly at: Date; readonly tenantId: string }) =>
            [query.tenantId, query.actor, String(DateTime.toEpochMillis(DateTime.makeUnsafe(query.at)))].join('\u0000'),
          authority.readConfigureBases,
        ),
  );

/** Each Action is asked in both modes, in this order. */
const ACTION_MODES = ['propose', 'run'] as const;

/**
 * The answer a question gets before any decision is taken: a carrier the subject cannot hold, or a context the
 * requester cannot ask about. Otherwise the company context the question is decided in, and its capability.
 */
const stageOf = (question: SubjectCapabilityInspectionInput, listing: boolean): StagedQuestion => {
  const { carrier } = question;
  // These are direct SUBJECT projections, not delegated calls. Module-only identity/workload
  // purposes have no human capability and inspection cannot manufacture the gateway's act proof.
  if (carrier.accessActor?.subject === 'workload' || carrier.accessDeclaration === undefined) {
    return {
      answer: {
        decision: seamRefusal(
          carrier.accessWorkload !== undefined || carrier.accessActor?.subject === 'workload'
            ? 'deny.workload_only'
            : 'deny.declaration_missing',
        ),
      },
    };
  }
  const scope = gateScopeOf(question.legalEntityScope, question.requesterScope);
  if (scope.refusal !== undefined) {
    return { answer: { decision: seamDenial(scope.refusal) } };
  }
  return withOptional(
    { capability: capabilityPolicyOf(carrier.accessDeclaration), listing, question },
    'legalEntityId',
    scope.legalEntityId,
  );
};

/** The evidence row of one decision that `shouldRecordDecision` keeps, exactly as a single inspection writes it. */
const entryOf = (pending: PendingQuestion, decision: AccessDecision): AccessDecisionLogEntry =>
  withOptional(
    withOptional(
      {
        actor: pending.resolved.actor,
        capability: pending.capability,
        decidedAt: pending.now,
        mode: pending.mode,
        onBehalfOfPrincipalId: PrincipalIdSchema.make(pending.question.requesterScope.principalId),
        outcome: decision.outcome,
        reasons: decision.reasons,
        scope: pending.question.requesterScope,
        scopeId: pending.resolved.scope.scopeId,
      },
      'target',
      pending.question.target?.recordKey,
    ),
    'admissionDeadline',
    decision.admissionDeadline,
  );

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
    authority: DecisionAuthorityPort,
    legalEntityId?: LegalEntityId,
  ) {
    const selected = yield* actorFor(input, legalEntityId);
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

  /** One resolution per distinct company context of a batch, never one per question. */
  const resolveContexts = Effect.fn('SubjectInspection.resolveContexts')(function* resolveContexts(
    input: SubjectInspectionInput,
    authority: DecisionAuthorityPort,
    staged: readonly StagedQuestion[],
  ) {
    const distinct = new Map<string, LegalEntityId | undefined>();
    for (const entry of staged) {
      if (entry.answer === undefined) {
        distinct.set(entry.legalEntityId ?? '', entry.legalEntityId);
      }
    }
    const entries = [...distinct.entries()];
    const resolved = yield* Effect.forEach(entries, ([, legalEntityId]) => resolve(input, authority, legalEntityId), {
      concurrency: 1,
    });
    return new Map(
      entries.flatMap(([key], index) => {
        const context = resolved[index];
        return context === undefined ? [] : [[key, context] as const];
      }),
    );
  });

  /** Every question that reaches the engine: the targetless ones in ONE snapshot, each LIST on its own. */
  const decidePending = Effect.fn('SubjectInspection.decidePending')(function* decidePending(
    pending: readonly PendingQuestion[],
  ) {
    const targetless = pending.filter(({ listing }) => !listing);
    const [first] = targetless;
    const [decided = []] =
      first === undefined
        ? [[]]
        : yield* decideAccessMany(ports.check, [
            {
              authority: first.authority,
              inputs: targetless.map(({ actor, capability, mode, now, question }) => ({
                actor,
                now,
                request: withOptional(
                  withOptional(
                    withOptional({ capability, mode }, 'amount', question.amount),
                    'target',
                    question.target,
                  ),
                  'parentRead',
                  question.parentRead,
                ),
              })),
            },
          ]);
    const listed = yield* Effect.forEach(
      pending.filter(({ listing }) => listing),
      ({ actor, authority, capability, mode, now }) =>
        resolveListAccess(authority, ports.check, { actor, capability, mode, now }),
      { concurrency: 2 },
    );
    // Each answer in pending order: the targetless ones and the LISTs each keep their own relative order.
    let targetlessAt = 0;
    let listedAt = 0;
    return pending.map(({ listing }): SubjectCapabilityAnswer | undefined => {
      if (listing) {
        listedAt += 1;
        return listed[listedAt - 1];
      }
      targetlessAt += 1;
      const decision = decided[targetlessAt - 1];
      return decision === undefined ? undefined : { decision };
    });
  });

  /**
   * Many questions about one subject, each answered as it would be alone: seam refusals first, then one subject
   * resolution per company context, then the engine, then every decision row that a single inspection would write —
   * all of them in one transaction. An unavailable decision or unwritable evidence fails the whole batch, after the
   * rows of the decisions that were taken are written; an allowed LIST without a predicate fails it as well.
   */
  const evaluateMany = Effect.fn('SubjectInspection.evaluateMany')(function* evaluateMany(
    input: SubjectInspectionInput,
    questions: readonly { readonly listing: boolean; readonly question: SubjectCapabilityInspectionInput }[],
  ) {
    const staged = questions.map(({ listing, question }) => stageOf(question, listing));
    const contexts = yield* resolveContexts(input, batchAuthorityOf(ports.authorityFor(input.requesterScope)), staged);
    const pending: PendingQuestion[] = [];
    const answers = staged.map((entry): AnswerSlot => {
      if (entry.answer !== undefined) {
        return { answer: entry.answer };
      }
      const prepared = contexts.get(entry.legalEntityId ?? '');
      if (prepared?.resolved === undefined || prepared.actor === undefined) {
        return { answer: { decision: prepared?.decision ?? seamRefusal(SCOPE_MISMATCH) } };
      }
      // LIST has no containing-record/parent-read input. Field decisions must use inspect with their
      // canonical parentRead, never the list engine's intentionally narrower read contract.
      if (entry.listing && entry.capability.kind !== 'read') {
        return { answer: { decision: seamRefusal('deny.mode_unsupported') } };
      }
      pending.push({
        actor: prepared.actor,
        authority: prepared.authority,
        capability: entry.capability,
        listing: entry.listing,
        mode: entry.question.mode ?? 'run',
        now: prepared.now,
        question: entry.question,
        resolved: prepared.resolved,
      });
      return { pending: pending.length - 1 };
    });
    const decided = yield* decidePending(pending);
    const evidence = pending.flatMap((entry, index) => {
      const decision = decided[index]?.decision;
      return decision !== undefined && shouldRecordDecision(decision, entry.capability)
        ? [entryOf(entry, decision)]
        : [];
    });
    if (evidence.length > 0) {
      yield* ports.decisionLog.recordAll(evidence).pipe(Effect.mapError(unavailable));
    }
    const engineAnswers = decided.flatMap((answer) => (answer === undefined ? [] : [answer]));
    if (engineAnswers.length !== pending.length) {
      return yield* unavailable('Subject inspection returned incomplete authority');
    }
    const failed = engineAnswers.find(({ decision }) => decision.outcome === 'UNAVAILABLE');
    if (failed !== undefined) {
      return yield* unavailable(failed.decision.reasons);
    }
    if (
      pending.some(
        (entry, index) =>
          entry.listing &&
          engineAnswers[index]?.decision.outcome === 'ALLOWED' &&
          engineAnswers[index]?.predicate === undefined,
      )
    ) {
      return yield* unavailable('An allowed LIST inspection has no predicate');
    }
    return answers.flatMap((slot) => {
      const resolved = slot.answer ?? engineAnswers[slot.pending];
      return resolved === undefined ? [] : [resolved];
    });
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
    const prepared = yield* resolve(input, ports.authorityFor(input.requesterScope), selected.legalEntityId);
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
  /**
   * The given capability questions and both modes of every named Action, asked of its current catalog declaration,
   * in ONE batch: an Action's `run` question is the same question its carrier asks, so the two share their reads.
   */
  const inspectBatch = Effect.fn('SubjectInspection.batch')(function* inspectBatch(
    input: SubjectInspectionInput & {
      readonly actionKeys: readonly string[];
      readonly questions: readonly SubjectCapabilityQuestion[];
    },
    catalog: SubjectInspectionCatalog,
  ) {
    const context = { queryScope: input.queryScope, requesterScope: input.requesterScope, subject: input.subject };
    const capabilityQuestions = input.questions.map(({ listing, ...question }) => ({
      listing,
      question: { ...question, ...context },
    }));
    const actionQuestions = input.actionKeys.flatMap((actionKey) => {
      const authority = catalog.actions.get(actionKey);
      const question = {
        ...context,
        carrier: authority?.carrier ?? {},
        legalEntityScope: authority?.legalEntityScope ?? 'optional',
      };
      return ACTION_MODES.map((mode) => ({ listing: false, question: { ...question, mode } }));
    });
    const answers = yield* evaluateMany(input, [...capabilityQuestions, ...actionQuestions]);
    const offset = capabilityQuestions.length;
    const allowed = (index: number) =>
      answers[offset + index]?.decision.outcome === 'ALLOWED' ? ('allowed' as const) : ('denied' as const);
    return {
      answers: answers.slice(0, offset),
      authorities: input.actionKeys.map((actionKey, index) => ({
        actionKey,
        propose: allowed(index * ACTION_MODES.length),
        run: allowed(index * ACTION_MODES.length + 1),
      })),
      inspectionOnly: true as const,
    };
  });

  const single = (input: SubjectCapabilityInspectionInput, listing: boolean) =>
    evaluateMany(input, [{ listing, question: input }]).pipe(
      Effect.flatMap(([answer]) =>
        answer === undefined
          ? Effect.fail(unavailable('Subject inspection returned no answer'))
          : Effect.succeed(answer),
      ),
    );

  return Object.freeze<SubjectAccessInspectionService>({
    actions: (input) =>
      checked(input, (catalog) =>
        inspectBatch({ ...input, questions: [] }, catalog).pipe(
          Effect.map(({ authorities }) => ({ authorities, inspectionOnly: true as const })),
        ),
      ),
    capabilities: (input) => checked(input, (catalog) => inspectBatch(input, catalog)),
    inspect: (input) =>
      checked(input, () =>
        single(input, false).pipe(Effect.map(({ decision }) => ({ decision, inspectionOnly: true as const }))),
      ),
    list: (input) =>
      checked(input, () =>
        single(input, true).pipe(Effect.map((result): SubjectListInspection => ({ inspectionOnly: true, ...result }))),
      ),

    scope: (input) => checked(input, () => inspectScope(input)),
  });
};
