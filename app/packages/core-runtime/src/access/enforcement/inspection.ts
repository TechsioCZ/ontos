import { DateTime, Deferred, Effect, Exit, Fiber, Option, Predicate, Schema } from 'effect';
import type { Scope } from 'effect';

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
  SubjectInspectionStages,
  SubjectAccessInspectionService,
  SubjectCapabilityAnswer,
  SubjectCapabilityInspectionInput,
  SubjectActionAnswer,
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

/** The resolution of the subject in one company context: its decision when refused, or what decisions are taken in. */
type ContextResolution =
  | {
      readonly actor?: undefined;
      readonly authority: DecisionAuthorityPort;
      readonly decision: AccessDecision;
      readonly resolved?: undefined;
    }
  | {
      readonly actor: ActorContextInput;
      readonly authority: DecisionAuthorityPort;
      readonly decision?: undefined;
      readonly now: Date;
      readonly resolved: ResolvedActor;
    };

/** What one inspection's questions share; see `sessionOf`. */
interface InspectionSession {
  /** Starts a read a later stage will ask for without waiting on it; a plain inspection starts nothing. */
  readonly ahead: <A, E>(read: Effect.Effect<A, E>) => Effect.Effect<void>;
  readonly authority: DecisionAuthorityPort;
  /** Writes one batch's evidence rows (in one transaction); a staged inspection waits for every write at its end. */
  readonly record: (rows: readonly AccessDecisionLogEntry[]) => Effect.Effect<void, SubjectInspectionUnavailable>;
  readonly resolveIn: (
    legalEntityId: LegalEntityId | undefined,
  ) => Effect.Effect<ContextResolution, SubjectInspectionUnavailable>;
}

/** Runs `effect` (interruptibly) and always completes `deferred` with its exit, an interruption included. */
const settledInto = <Value, Failure>(
  deferred: Deferred.Deferred<Value, Failure>,
  effect: Effect.Effect<Value, Failure>,
) => Effect.uninterruptible(Effect.onExit(Effect.interruptible(effect), (exit) => Deferred.done(deferred, exit)));

/**
 * One shared answer per key, also for callers that ask at the same time. The read of a key runs in ONE fiber of
 * `scope` that no caller owns: every caller, the first included, only waits for it, so a caller that is interrupted
 * (or whose sibling failed) stops waiting without cancelling the read another caller waits for. The entry and its
 * fiber are created together, uninterruptibly, and the fiber completes the entry on every exit, so a waiter always
 * gets a definite outcome; the read itself stays interruptible and ends with the scope at the latest.
 */
const sharedPerKey = <Query, Value, Failure>(
  keyOf: (query: Query) => string,
  read: (query: Query) => Effect.Effect<Value, Failure>,
  scope: Scope.Scope,
): ((query: Query) => Effect.Effect<Value, Failure>) => {
  const reads = new Map<string, Deferred.Deferred<Value, Failure>>();
  return (query) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const key = keyOf(query);
        const known = reads.get(key);
        if (known !== undefined) {
          return restore(Deferred.await(known));
        }
        const deferred = Deferred.makeUnsafe<Value, Failure>();
        reads.set(key, deferred);
        return settledInto(deferred, read(query)).pipe(
          Effect.forkIn(scope),
          Effect.andThen(restore(Deferred.await(deferred))),
        );
      }),
    );
};

const scopeQueryKey = (query: ScopeQuery): string =>
  [query.tenantId, query.legalEntityId ?? '', ...query.holders.map(holderIdOf)].join('\u0000');

/**
 * The intent port of ONE batch: the same port, but a question its questions share — the scope, the cells of one
 * holder, capability and mode, the configure bases at one instant — is read once instead of once per question. Only
 * for the batch it is made for, never across requests; the agent connection and team reads stay fresh per call.
 */
const batchAuthorityOf = (authority: DecisionAuthorityPort, scope: Scope.Scope): DecisionAuthorityPort =>
  withOptional(
    withOptional(
      {
        readCells: sharedPerKey(
          (query: AuthorityCellQuery) =>
            [query.tenantId, query.scopeId, holderIdOf(query.holder), query.capabilityKey, query.mode].join('\u0000'),
          authority.readCells,
          scope,
        ),
        readConnection: authority.readConnection,
        readScope: sharedPerKey(scopeQueryKey, authority.readScope, scope),
        readTeamIds: authority.readTeamIds,
      },
      // The engine reads one batch's cell sets in one call; each set is still read once per batch.
      'readCellsMany',
      authority.readCellsMany,
    ),
    'readConfigureBases',
    authority.readConfigureBases === undefined
      ? undefined
      : sharedPerKey(
          (query: { readonly actor: string; readonly at: Date; readonly tenantId: string }) =>
            [query.tenantId, query.actor, String(DateTime.toEpochMillis(DateTime.makeUnsafe(query.at)))].join('\u0000'),
          authority.readConfigureBases,
          scope,
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

/** The distinct company contexts the decided questions of a batch are asked in, keyed by company ('' = tenant). */
const contextsOf = (staged: readonly StagedQuestion[]): readonly (readonly [string, LegalEntityId | undefined])[] => {
  const distinct = new Map<string, LegalEntityId | undefined>();
  for (const entry of staged) {
    if (entry.answer === undefined) {
      distinct.set(entry.legalEntityId ?? '', entry.legalEntityId);
    }
  }
  return [...distinct.entries()];
};

/** A batch's capability questions and both modes of every named Action, as the current catalog declares them. */
const batchQuestionsOf = (
  input: SubjectInspectionInput & {
    readonly actionKeys: readonly string[];
    readonly questions: readonly SubjectCapabilityQuestion[];
  },
  catalog: SubjectInspectionCatalog,
) => {
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
  return { actionQuestions, capabilityQuestions };
};

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
    instant: Effect.Effect<Date>,
    legalEntityId?: LegalEntityId,
  ) {
    const selected = yield* actorFor(input, legalEntityId);
    if (selected.actor === undefined) {
      return { authority, decision: selected.decision ?? seamRefusal(PRINCIPAL_FORBIDDEN) };
    }
    const now = yield* instant;
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

  /**
   * What the questions of one inspection share: one batch intent port (a read its questions share is read once) and
   * one subject resolution per company context, taken at one instant. A plain call makes its own; the stages of one
   * staged inspection share one, exactly as the questions of one batch share it. Never shared across inspections.
   */
  const recordNow = (rows: readonly AccessDecisionLogEntry[]) =>
    ports.decisionLog.recordAll(rows).pipe(Effect.mapError(unavailable));

  const sessionOf = (
    input: SubjectInspectionInput,
    scope: Scope.Scope,
    staged?: Pick<InspectionSession, 'ahead' | 'record'>,
  ): InspectionSession => {
    const authority = batchAuthorityOf(ports.authorityFor(input.requesterScope), scope);
    // Every context of one inspection is decided at the one instant its first resolution takes, as the questions of
    // one batch always were. The instant is taken fresh by each inspection (each call, or each staged description),
    // never shared across them; a later stage decides at that instant, so one description answers for one instant.
    const instant = sharedPerKey(
      (key: 'now') => key,
      () => DateTime.nowAsDate,
      scope,
    );
    return {
      ahead: staged?.ahead ?? (() => Effect.void),
      authority,
      record: staged?.record ?? recordNow,
      resolveIn: sharedPerKey(
        (legalEntityId: LegalEntityId | undefined) => legalEntityId ?? '',
        (legalEntityId: LegalEntityId | undefined) => resolve(input, authority, instant('now'), legalEntityId),
        scope,
      ),
    };
  };

  /** A plain call's own session, whose shared reads end with the call. */
  const withSession = <A, E, R>(
    input: SubjectInspectionInput,
    use: (session: InspectionSession) => Effect.Effect<A, E, R>,
  ) => Effect.scoped(Effect.scope.pipe(Effect.flatMap((scope) => use(sessionOf(input, scope)))));

  /** One resolution per distinct company context of a batch (or of a staged inspection), never one per question. */
  const resolveContexts = Effect.fn('SubjectInspection.resolveContexts')(function* resolveContexts(
    session: InspectionSession,
    staged: readonly StagedQuestion[],
  ) {
    const entries = contextsOf(staged);
    // Distinct contexts are independent reads: two at a time, the same bound the engine keeps on the shared pool.
    const resolved = yield* Effect.forEach(entries, ([, legalEntityId]) => session.resolveIn(legalEntityId), {
      concurrency: 2,
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
    questions: readonly { readonly listing: boolean; readonly question: SubjectCapabilityInspectionInput }[],
    session: InspectionSession,
  ) {
    const staged = questions.map(({ listing, question }) => stageOf(question, listing));
    const contexts = yield* resolveContexts(session, staged);
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
      yield* session.record(evidence);
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

  const checked = Effect.fn('SubjectInspection.checked')(function* checked<A, E, R>(
    input: SubjectInspectionInput,
    body: (catalog: SubjectInspectionCatalog) => Effect.Effect<A, E, R>,
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

  const inspectScope = Effect.fn('SubjectInspection.scope')(function* inspectScope(
    input: SubjectInspectionInput,
    session: InspectionSession,
  ) {
    const selected = gateScopeOf(
      input.requesterScope.legalEntityId === undefined ? 'optional' : 'required',
      input.requesterScope,
    );
    const prepared = yield* session.resolveIn(selected.legalEntityId);
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
    session: InspectionSession,
  ) {
    const { actionQuestions, capabilityQuestions } = batchQuestionsOf(input, catalog);
    const answers = yield* evaluateMany([...capabilityQuestions, ...actionQuestions], session);
    const offset = capabilityQuestions.length;
    // A missing or UNAVAILABLE answer is `unavailable`, never `denied`, so no caller can read it as a refusal.
    const answerOf = (index: number): SubjectActionAnswer => {
      const outcome = answers[offset + index]?.decision.outcome;
      if (outcome === 'ALLOWED') {
        return 'allowed';
      }
      return outcome === undefined || outcome === 'UNAVAILABLE' ? 'unavailable' : 'denied';
    };
    return {
      answers: answers.slice(0, offset),
      authorities: input.actionKeys.map((actionKey, index) => ({
        actionKey,
        propose: answerOf(index * ACTION_MODES.length),
        run: answerOf(index * ACTION_MODES.length + 1),
      })),
      inspectionOnly: true as const,
    };
  });

  /** Resolves the subject in every company context these questions are asked in; decides and records nothing. */
  const prepareContexts = Effect.fn('SubjectInspection.prepare')(function* prepareContexts(
    input: SubjectInspectionInput & {
      readonly actionKeys: readonly string[];
      readonly questions: readonly SubjectCapabilityQuestion[];
    },
    catalog: SubjectInspectionCatalog,
    session: InspectionSession,
  ) {
    const { actionQuestions, capabilityQuestions } = batchQuestionsOf(input, catalog);
    const staged = [...capabilityQuestions, ...actionQuestions].map(({ listing, question }) =>
      stageOf(question, listing),
    );
    // Every context is started; one that cannot be resolved fails only the stage that later asks it (that stage
    // waits for the same shared resolution), so preparing never fails or cancels anything itself.
    const prepared = yield* Effect.forEach(
      contextsOf(staged),
      ([key, legalEntityId]) =>
        session.resolveIn(legalEntityId).pipe(
          Effect.exit,
          Effect.map((exit) => [key, exit] as const),
        ),
      { concurrency: 2 },
    );
    const contexts = new Map(
      prepared.flatMap(([key, exit]) => (Exit.isSuccess(exit) ? [[key, exit.value] as const] : [])),
    );
    // An admin question is decided from the person's configure bases, read at the context's resolution instant: the
    // same read a later batch asks, started now so that batch does not wait on it (the batch port shares it).
    const adminContexts = new Set(
      staged.flatMap((entry) =>
        entry.answer === undefined && entry.capability.kind === 'admin' ? [entry.legalEntityId ?? ''] : [],
      ),
    );
    const { readConfigureBases } = session.authority;
    if (readConfigureBases === undefined) {
      return;
    }
    yield* Effect.forEach(
      [...adminContexts].flatMap((key) => {
        const context = contexts.get(key);
        const actor = context?.actor?.actor;
        return context?.resolved === undefined || !Predicate.isTagged(actor, 'Principal')
          ? []
          : [{ actor: actor.principalId, at: context.now, tenantId: context.resolved.scope.tenantId }];
      }),
      (query) => session.ahead(readConfigureBases(query)),
      { concurrency: 1, discard: true },
    );
  });

  /**
   * The stages of one description over one session. A stage's evidence is written while the next stage reads. A
   * write, once started, cannot be interrupted (neither by a failed sibling write nor by the request going away), and
   * every write is awaited before the inspection answers, on success and on failure, so every row a taken decision
   * leaves is written either way. One failed write never cancels another; the first failure is reported once all have
   * settled. A read started ahead keeps its outcome for the stage that asks it and never fails it here.
   */
  const stagedInspection = Effect.fn('SubjectInspection.staged')(function* stagedInspection<A, E, R>(
    input: SubjectInspectionInput,
    catalog: SubjectInspectionCatalog,
    body: (stages: SubjectInspectionStages) => Effect.Effect<A, E, R>,
  ) {
    const scope = yield* Effect.scope;
    const writes: Fiber.Fiber<void, SubjectInspectionUnavailable>[] = [];
    const remember = (fiber: Fiber.Fiber<void, SubjectInspectionUnavailable>) => writes.push(fiber);
    const session = sessionOf(input, scope, {
      ahead: (read) => read.pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
      record: (rows) =>
        Effect.uninterruptible(recordNow(rows)).pipe(Effect.forkIn(scope), Effect.map(remember), Effect.asVoid),
    });
    const outcome = yield* body({
      capabilities: (asked) => inspectBatch({ ...input, ...asked }, catalog, session),
      prepare: (asked) => prepareContexts({ ...input, ...asked }, catalog, session),
      scope: inspectScope(input, session),
    }).pipe(Effect.exit);
    const written = yield* Fiber.awaitAll(writes);
    if (Exit.isFailure(outcome)) {
      return yield* Effect.failCause(outcome.cause);
    }
    const failedWrite = written.find((exit) => Exit.isFailure(exit));
    if (failedWrite !== undefined && Exit.isFailure(failedWrite)) {
      return yield* Effect.failCause(failedWrite.cause);
    }
    return outcome.value;
  });

  const single = (input: SubjectCapabilityInspectionInput, listing: boolean) =>
    withSession(input, (session) => evaluateMany([{ listing, question: input }], session)).pipe(
      Effect.flatMap(([answer]) =>
        answer === undefined
          ? Effect.fail(unavailable('Subject inspection returned no answer'))
          : Effect.succeed(answer),
      ),
    );

  return Object.freeze<SubjectAccessInspectionService>({
    actions: (input) =>
      checked(input, (catalog) =>
        withSession(input, (session) => inspectBatch({ ...input, questions: [] }, catalog, session)).pipe(
          Effect.map(({ authorities }) => ({ authorities, inspectionOnly: true as const })),
        ),
      ),
    capabilities: (input) =>
      checked(input, (catalog) => withSession(input, (session) => inspectBatch(input, catalog, session))),
    inspect: (input) =>
      checked(input, () =>
        single(input, false).pipe(Effect.map(({ decision }) => ({ decision, inspectionOnly: true as const }))),
      ),
    list: (input) =>
      checked(input, () =>
        single(input, true).pipe(Effect.map((result): SubjectListInspection => ({ inspectionOnly: true, ...result }))),
      ),

    scope: (input) => checked(input, () => withSession(input, (session) => inspectScope(input, session))),
    staged: (input, body) => checked(input, (catalog) => Effect.scoped(stagedInspection(input, catalog, body))),
  });
};
