import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { LegalEntityScope } from '../../operations/legal-entity-scope.ts';
import type { AccessAmount, AccessDecision, AccessRecordTarget, ParentReadRequirement } from '../decision/contract.ts';
import type { ListAccessPredicate } from '../decision/list-access.ts';
import type { AccessMode } from '../model.ts';
import type { GateCarrier } from './contract.ts';

import type { SubjectInspectionUnavailable } from './inspection-unavailable.ts';

/** A subject identity, NOT authentication, an execution scope, a lease or a permit. */
export interface InspectionSubject {
  /** Exact credential-bound consent context. Never use an OAuth grant id as a connection id. */
  readonly agentContext?: {
    readonly connectionId: string;
    readonly consentRevision: number;
    /** The human named by this specific persisted connection, not the evaluator. */
    readonly principalId: string;
  };
  readonly principalId: string;
  readonly tenantId: string;
}

export interface SubjectInspectionInput {
  /** Queried context, never authentication. Must exactly match the evaluator's selected context. */
  readonly queryScope: {
    readonly legalEntityId?: string;
    readonly tenantId: string;
  };
  /** The original authenticated evaluator object. Every database/kind/evidence port receives it unchanged. */
  readonly requesterScope: OperationalScope;
  readonly subject: InspectionSubject;
}

export interface SubjectCapabilityInspectionInput extends SubjectInspectionInput {
  readonly amount?: AccessAmount;
  readonly carrier: GateCarrier;
  readonly legalEntityScope: LegalEntityScope;
  readonly mode?: AccessMode;
  readonly parentRead?: ParentReadRequirement;
  readonly target?: AccessRecordTarget;
}

export interface SubjectCapabilityInspection {
  readonly decision: AccessDecision;
  readonly inspectionOnly: true;
}

export interface SubjectListInspection {
  readonly decision: AccessDecision;
  readonly inspectionOnly: true;
  readonly predicate?: ListAccessPredicate;
}

/**
 * One capability question of a batch, in the batch's subject and context. `listing` asks the LIST question of a
 * selector-bearing read (as `list` does); otherwise it is the targetless decision `inspect` takes.
 */
export interface SubjectCapabilityQuestion extends Omit<
  SubjectCapabilityInspectionInput,
  keyof SubjectInspectionInput
> {
  readonly listing: boolean;
}

/** One batch answer: the decision `inspect` or `list` gives that question alone, and LIST's predicate. */
export interface SubjectCapabilityAnswer {
  readonly decision: AccessDecision;
  readonly predicate?: ListAccessPredicate;
}

export interface SubjectCapabilityBatchInspection {
  /** In question order. */
  readonly answers: readonly SubjectCapabilityAnswer[];
  /** In `actionKeys` order, exactly as `actions` answers them. */
  readonly authorities: SubjectActionInspection['authorities'];
  readonly inspectionOnly: true;
}

export interface SubjectScopeInspection {
  readonly decision: 'allowed' | 'denied';
  readonly inspectionOnly: true;
  readonly reasonCodes: readonly string[];
}

/** An Action mode's answer; `unavailable` is never a denial, so a caller can fail closed on it. */
export const SubjectActionAnswerSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type SubjectActionAnswer = typeof SubjectActionAnswerSchema.Type;

export interface SubjectActionInspection {
  readonly authorities: readonly {
    readonly actionKey: string;
    readonly propose: SubjectActionAnswer;
    readonly run: SubjectActionAnswer;
  }[];
  readonly inspectionOnly: true;
}

export { SubjectInspectionUnavailable } from './inspection-unavailable.ts';

/** Projection only. Callers must still use the governed operation's normal execution admission. */
export interface SubjectAccessInspectionService {
  readonly actions: (
    input: SubjectInspectionInput & { readonly actionKeys: readonly string[] },
  ) => Effect.Effect<SubjectActionInspection, SubjectInspectionUnavailable>;
  /**
   * Many capability questions and Actions about one subject in one context, each answered exactly as `inspect`/`list`
   * /`actions` answers it alone: the subject and its scope are resolved once per company context, every targetless
   * decision shares one engine snapshot, an intent read the questions share is read once, and every decision row the
   * single calls would write is written, all in one transaction.
   */
  readonly capabilities: (
    input: SubjectInspectionInput & {
      readonly actionKeys: readonly string[];
      readonly questions: readonly SubjectCapabilityQuestion[];
    },
  ) => Effect.Effect<SubjectCapabilityBatchInspection, SubjectInspectionUnavailable>;
  readonly inspect: (
    input: SubjectCapabilityInspectionInput,
  ) => Effect.Effect<SubjectCapabilityInspection, SubjectInspectionUnavailable>;
  readonly list: (
    input: SubjectCapabilityInspectionInput,
  ) => Effect.Effect<SubjectListInspection, SubjectInspectionUnavailable>;
  /** Inspect selection of the requester's EXACT company, or tenant membership when it has no company. */
  readonly scope: (
    input: SubjectInspectionInput,
  ) => Effect.Effect<SubjectScopeInspection, SubjectInspectionUnavailable>;
  /**
   * One description in stages: `scope` and any number of `capabilities` batches about ONE subject, where a later
   * stage depends on an earlier answer. Every question is answered and evidenced exactly as in the single calls;
   * the stages share one subject resolution per company context (one instant) and one batch intent port, as the
   * questions of one batch do, and one composition-revision check spans them all. Never shared across calls.
   */
  readonly staged: <A, E, R>(
    input: SubjectInspectionInput,
    body: (stages: SubjectInspectionStages) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SubjectInspectionUnavailable, R>;
}

/** The stages of one staged inspection; see `SubjectAccessInspectionService['staged']`. */
export interface SubjectInspectionStages {
  readonly capabilities: (asked: {
    readonly actionKeys: readonly string[];
    readonly questions: readonly SubjectCapabilityQuestion[];
  }) => Effect.Effect<SubjectCapabilityBatchInspection, SubjectInspectionUnavailable>;
  /**
   * Starts resolving the subject in every company context these questions would be asked in, so a later stage does
   * not wait for it. Decides nothing, records no evidence and never fails: a context it could not resolve fails only
   * the stage that asks it.
   */
  readonly prepare: (asked: {
    readonly actionKeys: readonly string[];
    readonly questions: readonly SubjectCapabilityQuestion[];
  }) => Effect.Effect<void>;
  readonly scope: Effect.Effect<SubjectScopeInspection, SubjectInspectionUnavailable>;
}

export class SubjectAccessInspection extends Context.Service<SubjectAccessInspection, SubjectAccessInspectionService>()(
  '@app/core-runtime/access/enforcement/inspection-contract/SubjectAccessInspection',
) {}
