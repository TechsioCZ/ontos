/**
 * Extra access questions of a read (access lane of the execution kernel, `reads/sdk-contract.ts`).
 *
 * A read's descriptor may name, as data, further questions its handler needs answered: may this caller
 * run that operation, which rows of that read may it see, may it see that field group. The module never
 * holds the access gate: `materializeAccessQuestions` turns the descriptor data into concrete gate
 * questions once, at definition, and `answerAccessQuestions` lets Core ask them with the gate after the
 * read's own decision allowed it, in the same scope, at the same `now` and in the same transaction, and
 * hands the answers to the module as data.
 */
import { Effect, Match, Option, Result, Schema } from 'effect';

import type { AccessDecision, ParentReadRequirement } from '../access/decision/contract.ts';
import type { ListAccessResolution } from '../access/decision/engine.ts';
import { withOptional } from '../access/decision/optional.ts';
import { capabilityPolicyOf } from '../access/enforcement/capability.ts';
import type { GateCarrier, GateInput, ListGateInput } from '../access/enforcement/contract.ts';
import { AccessFieldGroupSchema } from '../authorization/access-declaration.ts';
import type { AccessDeclaration, AccessFieldGroup } from '../authorization/access-declaration.ts';
import type { BoundAccessGate } from '../operations/access-gate.ts';
import type {
  AccessAnswerOf,
  AccessAnswers,
  AccessQuestion,
  AccessQuestions,
  AccessQuestionTarget,
  FieldAnswer,
  ListAnswer,
  RunAnswer,
} from '../sdk/read.ts';
import { ReadDefinitionInvariantError } from './read-definition-invariant-error.ts';
import type { AnswerAccessQuestions, MaterializeAccessQuestions, MaterializedAccessQuestion } from './sdk-contract.ts';

/** A read asks at most this many extra questions: each one is a gate decision on its request path. */
export const MAX_ACCESS_QUESTIONS = 16;

/** The read access kinds decided as a list, whose own decision carries the row predicate (D16, O25). */
const ROW_SCOPED_READ_ACCESS_KINDS: ReadonlySet<string> = new Set(['list', 'report', 'search']);

const refuseAccessQuestions = (message: string): never => {
  throw new ReadDefinitionInvariantError({ message });
};

const isAccessFieldGroup = Schema.is(AccessFieldGroupSchema);

/** The parent read a question rides: the parent's capability, decided scope-wide (D14, O74). */
const parentReadOf = (parent: AccessDeclaration): ParentReadRequirement =>
  Object.freeze({ capability: capabilityPolicyOf(parent) });

/** Field access rides the parent read it belongs to (D14): the engine's own rule, read the same way. */
const requiresParentRead = (declaration: AccessDeclaration): boolean =>
  declaration.fieldClass !== undefined || declaration.kind === 'field_read' || declaration.kind === 'field_write';

/** The target operation's own carrier, exactly as its decoded descriptor carries it. */
const targetCarrierOf = (descriptor: AccessQuestionTarget['descriptor']): GateCarrier =>
  Object.freeze(
    withOptional(
      withOptional(
        withOptional(
          {
            entrypoint: Object.freeze({ entrypointKey: descriptor.entrypoint.entrypointKey }),
            schemaVersion: descriptor.schemaVersion,
          },
          'accessDeclaration',
          descriptor.accessDeclaration,
        ),
        'accessWorkload',
        descriptor.accessWorkload,
      ),
      'accessActor',
      descriptor.accessActor,
    ),
  );

/**
 * Two carriers ask the same question when they are the same registration: the same entrypoint at the
 * same schema version with the same declaration. A carrier without an entrypoint is never the same.
 */
const sameCarrier = (left: GateCarrier, right: GateCarrier): boolean =>
  left.entrypoint !== undefined &&
  right.entrypoint !== undefined &&
  left.entrypoint.entrypointKey === right.entrypoint.entrypointKey &&
  left.schemaVersion === right.schemaVersion &&
  left.accessDeclaration?.key === right.accessDeclaration?.key &&
  (left.accessWorkload === undefined) === (right.accessWorkload === undefined);

/**
 * A field group is always decided on rights (D6, O17): a target that admits module callers keeps its
 * callers on the group but decides the subject's own grants, exactly as the read runtime decides a read's
 * own field groups.
 */
const fieldGroupActorOf = (actor: GateCarrier['accessActor']): GateCarrier['accessActor'] =>
  actor === undefined ? undefined : Object.freeze({ callers: actor.callers, reason: actor.reason, subject: 'rights' });

const fieldQuestionOf = (
  name: string,
  question: Extract<AccessQuestion, { readonly kind: 'can_see_fields' }>,
  carrier: GateCarrier,
): MaterializedAccessQuestion => {
  const { descriptor } = question.target;
  const parent = descriptor.accessDeclaration;
  if (parent === undefined) {
    return refuseAccessQuestions(
      `Access question ${name}: can_see_fields needs a target with an accessDeclaration, the parent read of its field groups`,
    );
  }
  const group: unknown = (descriptor.accessFieldGroups ?? []).find((candidate) => candidate.key === question.groupKey);
  if (group === undefined || !isAccessFieldGroup(group)) {
    return refuseAccessQuestions(
      `Access question ${name}: ${descriptor.entrypoint.entrypointKey} declares no field group ${question.groupKey}`,
    );
  }
  if (parent.selectors.length > 0) {
    return refuseAccessQuestions(
      `Access question ${name}: a field question is asked scope-wide, so its parent declaration ${parent.key} cannot be record-scoped (O74)`,
    );
  }
  const fieldGroup: AccessFieldGroup = group;
  return Object.freeze({
    carrier: Object.freeze(
      withOptional(
        { ...carrier, accessDeclaration: fieldGroup },
        'accessActor',
        fieldGroupActorOf(descriptor.accessActor),
      ),
    ),
    kind: 'field',
    legalEntityScope: descriptor.legalEntityScope,
    name,
    parentRead: parentReadOf(parent),
    sameAsOwnDecision: false,
  });
};

const materializeAccessQuestion = (
  read: Parameters<MaterializeAccessQuestions>[0],
  name: string,
  question: AccessQuestion,
): MaterializedAccessQuestion => {
  const { descriptor } = question.target;
  if (descriptor.accessDeclaration === undefined && descriptor.accessWorkload === undefined) {
    return refuseAccessQuestions(
      `Access question ${name}: ${descriptor.entrypoint.entrypointKey} carries no protected access carrier`,
    );
  }
  const carrier = targetCarrierOf(descriptor);
  if (question.kind === 'can_see_fields') {
    return fieldQuestionOf(name, question, carrier);
  }
  const declaration = descriptor.accessDeclaration;
  const kind: MaterializedAccessQuestion['kind'] = question.kind === 'can_run' ? 'decide' : 'list';
  if (kind === 'decide' && declaration !== undefined && declaration.selectors.length > 0) {
    return refuseAccessQuestions(
      `Access question ${name}: can_run is asked scope-wide, but ${declaration.key} is record-scoped; ask can_list`,
    );
  }
  const asked = {
    carrier,
    kind,
    legalEntityScope: descriptor.legalEntityScope,
    name,
    sameAsOwnDecision:
      sameCarrier(read.carrier, carrier) && (kind === 'decide' || ROW_SCOPED_READ_ACCESS_KINDS.has(read.accessKind)),
  };
  // A field capability run as an operation rides its own capability decided scope-wide, the parent read
  // of a scope-wide entrypoint (O74); the engine refuses it without one.
  if (kind === 'decide' && declaration !== undefined && requiresParentRead(declaration)) {
    return Object.freeze({ ...asked, parentRead: parentReadOf(declaration) });
  }
  return Object.freeze(asked);
};

/**
 * Definition time: every descriptor question becomes one concrete gate question, or the read is refused
 * (no protected carrier, a scope-wide question on a record-scoped declaration, an unknown field group,
 * more than {@link MAX_ACCESS_QUESTIONS}).
 */
export const materializeAccessQuestions: MaterializeAccessQuestions = (read, questions) => {
  const entries = Object.entries(questions);
  if (entries.length > MAX_ACCESS_QUESTIONS) {
    return refuseAccessQuestions(
      `A read asks at most ${MAX_ACCESS_QUESTIONS} access questions; this one asks ${entries.length}`,
    );
  }
  return Object.freeze(entries.map(([name, question]) => materializeAccessQuestion(read, name, question)));
};

type AccessAnswer = AccessAnswerOf<AccessQuestion>;
type AnswerAccessQuestionsInput = Parameters<AnswerAccessQuestions>[0];

const UNAVAILABLE_LIST: ListAnswer = Result.fail('unavailable');

const unavailableAnswer = (question: MaterializedAccessQuestion): AccessAnswer =>
  question.kind === 'list' ? UNAVAILABLE_LIST : 'unavailable';

/** `NEEDS_APPROVAL` is the caller's right to propose the operation, not to run it. */
const runAnswerOf = (decision: AccessDecision): RunAnswer =>
  Match.value(decision.outcome).pipe(
    Match.withReturnType<RunAnswer>(),
    Match.when('ALLOWED', () => 'allowed'),
    Match.when('NEEDS_APPROVAL', () => 'needs_approval'),
    Match.when('UNAVAILABLE', () => 'unavailable'),
    Match.when('DENIED', () => 'denied'),
    Match.exhaustive,
  );

/** A field group is never proposable from a read: anything but an allow hides it. */
const fieldAnswerOf = (decision: AccessDecision): FieldAnswer => {
  if (decision.outcome === 'ALLOWED') {
    return 'allowed';
  }
  return decision.outcome === 'UNAVAILABLE' ? 'unavailable' : 'denied';
};

/**
 * Only an allowed list with a predicate names rows; any other answer (denied, proposable, or a predicate
 * that describes no row) is the empty set, never an unfiltered read (B1, D16, O25).
 */
const listAnswerOf = (decision: AccessDecision, predicate: ListAccessResolution['predicate']): ListAnswer => {
  if (decision.outcome === 'UNAVAILABLE') {
    return UNAVAILABLE_LIST;
  }
  return Result.succeed(decision.outcome === 'ALLOWED' ? Option.fromUndefinedOr(predicate) : Option.none());
};

const decisionAnswerOf = (question: MaterializedAccessQuestion, decision: AccessDecision | undefined): AccessAnswer => {
  if (decision === undefined) {
    return unavailableAnswer(question);
  }
  return question.kind === 'field' ? fieldAnswerOf(decision) : runAnswerOf(decision);
};

/** The read's own decision answers a question about its own carrier: it is never asked twice. */
const ownAnswerOf = (question: MaterializedAccessQuestion, own: AnswerAccessQuestionsInput['own']): AccessAnswer =>
  question.kind === 'list' ? listAnswerOf(own.decision, own.listAccess) : decisionAnswerOf(question, own.decision);

interface AskedDecision {
  readonly input: GateInput;
  readonly question: MaterializedAccessQuestion;
}

/** Every `decide` and field question in one batch where the gate offers it, else one by one. */
const decideAll = (
  gate: BoundAccessGate,
  asked: readonly AskedDecision[],
  transaction: AnswerAccessQuestionsInput['transaction'],
): Effect.Effect<readonly (readonly [string, AccessAnswer])[]> => {
  if (asked.length === 0) {
    return Effect.succeed([]);
  }
  const inputs = asked.map(({ input }) => input);
  const { decideMany } = gate;
  const decisions =
    decideMany === undefined
      ? Effect.forEach(inputs, (input) => gate.decide(input, transaction), { concurrency: 1 })
      : decideMany(inputs, transaction);
  // A batch that answers fewer questions than it was asked leaves the rest unanswered: unavailable.
  return decisions.pipe(
    Effect.map((answers) =>
      asked.map(({ question }, index) => [question.name, decisionAnswerOf(question, answers[index])] as const),
    ),
  );
};

const listAll = (
  gate: BoundAccessGate,
  asked: readonly MaterializedAccessQuestion[],
  base: Pick<ListGateInput, 'now' | 'scope'>,
  transaction: AnswerAccessQuestionsInput['transaction'],
): Effect.Effect<readonly (readonly [string, AccessAnswer])[]> =>
  Effect.forEach(
    asked,
    (question) =>
      gate
        .list({ ...base, carrier: question.carrier, legalEntityScope: question.legalEntityScope }, transaction)
        .pipe(Effect.map((listing) => [question.name, listAnswerOf(listing.decision, listing.predicate)] as const)),
    { concurrency: 1 },
  );

const answersOf = (entries: readonly (readonly [string, AccessAnswer])[]): AccessAnswers<AccessQuestions> =>
  Object.freeze(Object.fromEntries(entries));

/**
 * The gate's answers, by question name. Asked only after the read's own decision is ALLOWED: a read that
 * is denied or unavailable asks nothing, so no question can change the read's own answer. Never fails.
 */
function answerAccessQuestionsProgram<Questions extends AccessQuestions>(
  input: AnswerAccessQuestionsInput,
): Effect.Effect<AccessAnswers<Questions>>;
function answerAccessQuestionsProgram(
  input: AnswerAccessQuestionsInput,
): Effect.Effect<AccessAnswers<AccessQuestions>> {
  const { gate, now, own, questions, scope, transaction } = input;
  if (gate === undefined || own.decision.outcome !== 'ALLOWED') {
    return Effect.succeed(answersOf(questions.map((question) => [question.name, unavailableAnswer(question)])));
  }
  const settled: (readonly [string, AccessAnswer])[] = [];
  const decisions: AskedDecision[] = [];
  const lists: MaterializedAccessQuestion[] = [];
  for (const question of questions) {
    const base = { carrier: question.carrier, legalEntityScope: question.legalEntityScope, now, scope };
    if (question.sameAsOwnDecision) {
      settled.push([question.name, ownAnswerOf(question, own)]);
    } else if (question.kind === 'list') {
      lists.push(question);
    } else {
      decisions.push({ input: withOptional(base, 'parentRead', question.parentRead), question });
    }
  }
  return Effect.all([decideAll(gate, decisions, transaction), listAll(gate, lists, { now, scope }, transaction)], {
    concurrency: 1,
  }).pipe(
    Effect.map(([decided, listed]) => answersOf([...settled, ...decided, ...listed])),
    Effect.withSpan('ReadAccessQuestions.answer'),
  );
}

export const answerAccessQuestions: AnswerAccessQuestions = answerAccessQuestionsProgram;
