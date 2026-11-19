/**
 * `@app/core-runtime/sdk/read`: the read authoring form.
 *
 * A read is still defined with `defineRead` from `@app/core-runtime`, with one of three spellings of
 * its second argument:
 *
 * - a bare handler, or `{ load: handler }`: one transaction, exactly as today. A `{ load }` read's
 *   descriptor may add `accessQuestions` (a bare handler may not); the handler then also receives
 *   `context.access`, and it stays one transaction.
 * - `{ run }`: the new form, for a read that needs a call or more than one transaction. `run` receives
 *   the neutral capabilities (`call`, `transaction`) plus the read's own facts and answers, and returns
 *   the read's answer. The descriptor declares every call it can make in `calls`.
 *
 * Read-only things live here and nowhere in the neutral SDK: list access, denied fields, access
 * questions and read evidence.
 */
import { Schema } from 'effect';
import type { Effect, Option, Result } from 'effect';

import type { ListAccessPredicate } from '../access/decision/list-access.ts';
import type { GateCarrier } from '../access/enforcement/contract.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { ReadEvidenceMetadata, ReadHandlerContext, ReadHandlerResult } from '../reads/context.ts';
import type { AnyReadOperationRef, DeclaredCall, ExecutionCapabilities, RequestExecution } from './index.ts';

/* ------------------------------------------------------------------------------------------------ */
/* Extra access questions: data on the descriptor, answered by Core                                 */
/* ------------------------------------------------------------------------------------------------ */

/**
 * A registered operation an access question is about: any Action or read registration (its decoded
 * descriptor). Core asks the access gate about this operation's own carrier; the module never holds the
 * gate.
 */
export interface AccessQuestionTarget {
  readonly descriptor: Readonly<{
    readonly accessActor?: GateCarrier['accessActor'];
    readonly accessDeclaration?: GateCarrier['accessDeclaration'];
    readonly accessFieldGroups?: readonly Readonly<{ readonly key: string }>[];
    readonly accessWorkload?: GateCarrier['accessWorkload'];
    readonly entrypoint: Readonly<{ readonly entrypointKey: string; readonly moduleKey: string }>;
    readonly legalEntityScope: LegalEntityScope;
    readonly schemaVersion: string;
  }>;
}

/**
 * One extra question, asked scope-wide in the read's own scope. Descriptor data, like
 * `accessDeclaration`, so it is discriminated by `kind`:
 *
 * - `can_run`: may this caller run that operation (write here, assign there). Its declaration must be
 *   scope-wide (no record selectors): a record-scoped question is a `can_list`.
 * - `can_list`: which rows of that operation may this caller see; the answer is the row predicate.
 * - `can_see_fields`: may this caller see that operation's field group `groupKey`.
 */
export interface CanRunQuestion {
  readonly kind: 'can_run';
  readonly target: AccessQuestionTarget;
}
export interface CanListQuestion {
  readonly kind: 'can_list';
  readonly target: AccessQuestionTarget;
}
export interface CanSeeFieldsQuestion {
  readonly groupKey: string;
  readonly kind: 'can_see_fields';
  readonly target: AccessQuestionTarget;
}
export type AccessQuestion = CanListQuestion | CanRunQuestion | CanSeeFieldsQuestion;

export type AccessQuestions = Readonly<Record<string, AccessQuestion>>;
export type NoAccessQuestions = Readonly<Record<never, AccessQuestion>>;

export const canRun = (target: AccessQuestionTarget): CanRunQuestion => Object.freeze({ kind: 'can_run', target });
export const canList = (target: AccessQuestionTarget): CanListQuestion => Object.freeze({ kind: 'can_list', target });
export const canSeeFields = (target: AccessQuestionTarget, groupKey: string): CanSeeFieldsQuestion =>
  Object.freeze({ groupKey, kind: 'can_see_fields', target });

/** `needs_approval`: the caller may propose it, not run it directly. */
export const RunAnswerSchema = Schema.Literals(['allowed', 'denied', 'needs_approval', 'unavailable']);
export type RunAnswer = typeof RunAnswerSchema.Type;
export const FieldAnswerSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type FieldAnswer = typeof FieldAnswerSchema.Type;
/**
 * Success with `Some(predicate)`: apply it in the owner query. Success with `None`: the caller may see
 * no row. Failure: the gate could not answer.
 */
export type ListAnswer = Result.Result<Option.Option<ListAccessPredicate>, 'unavailable'>;

export type AccessAnswerOf<Question extends AccessQuestion> = Question extends CanListQuestion
  ? ListAnswer
  : Question extends CanSeeFieldsQuestion
    ? FieldAnswer
    : RunAnswer;

/** The answers, by the names the descriptor gave its questions. */
export type AccessAnswers<Questions extends AccessQuestions> = {
  readonly [Name in keyof Questions]: AccessAnswerOf<Questions[Name]>;
};

/* ------------------------------------------------------------------------------------------------ */
/* The new form                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/** A read calls only read operations. */
export type ReadCalls = Readonly<Record<string, DeclaredCall<AnyReadOperationRef>>>;
export type NoReadCalls = Readonly<Record<never, DeclaredCall<AnyReadOperationRef>>>;

/** What `run` receives: the neutral capabilities, plus what only a read has. */
export interface ReadRunContext<
  Services,
  Calls extends ReadCalls,
  Questions extends AccessQuestions,
> extends ExecutionCapabilities<Services, Calls, RequestExecution> {
  /** Core's answers to the descriptor's `accessQuestions`, asked after the read's own decision allowed it. */
  readonly access: AccessAnswers<Questions>;
  /** As on the one-transaction form: present exactly when the access gate decided this read. */
  readonly deniedFieldPaths?: readonly (readonly string[])[];
  /** As on the one-transaction form: present exactly for a row-scoped read decided by the gate. */
  readonly listAccess?: ListAccessPredicate;
  readonly readKey: string;
  /** The trusted scope; `scope.correlationId` and `scope.traceId` identify the request, as today. */
  readonly scope: OperationalScope;
}

export type ReadRun<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Services,
  Calls extends ReadCalls,
  Questions extends AccessQuestions,
  HandlerError,
  Requirements = never,
> = (
  input: InputSchema['Type'],
  context: ReadRunContext<Services, Calls, Questions>,
) => Effect.Effect<ReadHandlerResult<ResultSchema['Type']>, HandlerError, Requirements>;

/** The second argument of `defineRead` in the new form: an object whose only own key is `run`. */
export interface ReadRunStep<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Services,
  Calls extends ReadCalls,
  Questions extends AccessQuestions,
  HandlerError,
  Requirements = never,
> {
  readonly run: ReadRun<InputSchema, ResultSchema, Services, Calls, Questions, HandlerError, Requirements>;
}

/** The descriptor fields the SDK adds to a read descriptor; both are data a parser can see. */
export interface ReadSdkDescriptorFields<Calls extends ReadCalls, Questions extends AccessQuestions> {
  readonly accessQuestions?: Questions;
  /** Every call the read can make, by name. Only the `{ run }` form may declare calls. */
  readonly calls?: Calls;
}

/**
 * The context of a one-transaction handler: with the answers to the descriptor's `accessQuestions` when
 * it names any, and otherwise the bare handler's context, whose `access` Core leaves out.
 */
export type ReadLoadContextWithAnswers<Services, Questions extends AccessQuestions> = ReadHandlerContext<Services> &
  ([keyof Questions] extends [never] ? unknown : { readonly access: AccessAnswers<Questions> });

/** A one-transaction handler that also receives Core's answers to the descriptor's questions. */
export type ReadLoadWithAnswers<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Services,
  Questions extends AccessQuestions,
  HandlerError,
  Requirements = never,
> = (
  input: InputSchema['Type'],
  context: ReadLoadContextWithAnswers<Services, Questions>,
) => Effect.Effect<ReadHandlerResult<ResultSchema['Type']>, HandlerError, Requirements>;

/** The `{ load }` spelling of such a handler. */
export interface ReadLoadStepWithAnswers<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Services,
  Questions extends AccessQuestions,
  HandlerError,
  Requirements = never,
> {
  readonly load: ReadLoadWithAnswers<InputSchema, ResultSchema, Services, Questions, HandlerError, Requirements>;
}

/** A read's answer: its result and the evidence metadata its capture mode allows. */
export const readAnswer = <Value>(result: Value, evidence: ReadEvidenceMetadata): ReadHandlerResult<Value> =>
  Object.freeze({ evidence, result });
