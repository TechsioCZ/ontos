import type { BoundAccessGate, OperationalScope } from '@app/core-runtime';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import type { GateInput, SelectableLegalEntitiesInput, TestAccessDecision } from '@app/core-runtime/access/enforcement';
import { makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { Effect, Schema } from 'effect';

/**
 * The answers a Shell suite scripts for one declaration. `selection_required` is the Shell's own
 * reading of the gate: a company-scoped capability asked without a selected company comes back as a
 * denial with `deny.scope_mismatch` (O28), never as a separate engine outcome.
 */
const ShellTestAccessSchema = Schema.Literals([
  'allowed',
  'denied',
  'needs_approval',
  'selection_required',
  'unavailable',
]);
export type ShellTestAccess = typeof ShellTestAccessSchema.Type;

const OUTCOME_OF = {
  allowed: 'ALLOWED',
  denied: 'DENIED',
  needs_approval: 'NEEDS_APPROVAL',
  selection_required: 'DENIED',
  unavailable: 'UNAVAILABLE',
} as const;

const REASON_OF = {
  allowed: 'allow.granted',
  denied: 'deny.insufficient_grant',
  needs_approval: 'approval.required',
  selection_required: 'deny.scope_mismatch',
  unavailable: 'unavailable.intent',
} as const;

const decisionOf = (access: ShellTestAccess) => ({
  evidence: [],
  outcome: OUTCOME_OF[access],
  reasons: [{ code: REASON_OF[access] }] as const,
  selectors: [],
});

export interface ShellTestAccessGate extends TestAccessDecision {
  /** One entry per `decideMany` call: how many engine snapshots one page needed (E-BATCH). */
  readonly batches: readonly (readonly GateInput[])[];
  /** The same gate as a runtime asks it, for a composition that binds the seam itself. */
  readonly bound: BoundAccessGate;
  /** Every question the Shell asked, batched or not. */
  readonly decisions: readonly GateInput[];
  readonly selectableAsks: readonly SelectableLegalEntitiesInput[];
  /** The single-question calls. Navigation must never appear here (E-BATCH). */
  readonly singleDecisions: readonly GateInput[];
}

export interface ShellTestAccessGateOptions {
  /** Answers by declaration key, read on every call; anything unnamed falls back to `defaultAnswer`. */
  readonly answers?: Readonly<Record<string, ShellTestAccess>>;
  readonly defaultAnswer?: ShellTestAccess;
  /** The companies the select check answers with; the default is none. */
  readonly selectableLegalEntityIds?: readonly string[];
  /** Answers the company question as an unreadable authority. */
  readonly selectionUnavailable?: boolean;
}

/**
 * The gate a Shell suite provides instead of `AccessDecisionLive`: it decides nothing and proves
 * nothing, it answers what the suite scripted and records how the Shell asked — so a suite can prove
 * one batched engine snapshot per page (E-BATCH) and one question per protected surface.
 *
 * Two of the seam's own rules are reproduced here because a suite must not be able to script an
 * answer the live gate would never give: a company-scoped capability without a selected company is
 * refused with `deny.scope_mismatch` (O7, O28), and an unnamed declaration is denied (O62).
 */
export const makeShellTestAccessGate = (options: ShellTestAccessGateOptions = {}): ShellTestAccessGate => {
  const singleDecisions: GateInput[] = [];
  const decisions: GateInput[] = [];
  const batches: (readonly GateInput[])[] = [];
  const selectableAsks: SelectableLegalEntitiesInput[] = [];
  const selectable = (options.selectableLegalEntityIds ?? []).map((id) => LegalEntityIdSchema.make(id));
  const companies =
    options.selectionUnavailable === true
      ? makeTestAccessDecision({ legalEntityIds: selectable, unavailable: true })
      : makeTestAccessDecision({ legalEntityIds: selectable });
  const answerOf = (
    input: Pick<GateInput, 'carrier' | 'legalEntityScope' | 'scope'>,
  ): ReturnType<typeof decisionOf> => {
    if (input.legalEntityScope === 'required' && input.scope.legalEntityId === undefined) {
      return decisionOf('selection_required');
    }
    const key = input.carrier.accessDeclaration?.key;
    if (key === undefined) {
      // A protected carrier without a declaration is refused by the live gate too (O62): a suite
      // can never script an allow for an entrypoint that carries no capability.
      return decisionOf('denied');
    }
    return decisionOf(options.answers?.[key] ?? options.defaultAnswer ?? 'denied');
  };
  const gate: Omit<ShellTestAccessGate, 'bound'> = {
    askedDecisions: decisions,
    askedLists: [],
    askedSelectableLegalEntities: selectableAsks,
    batches,
    decide: (input) => {
      singleDecisions.push(input);
      decisions.push(input);
      return Effect.succeed(answerOf(input));
    },
    decideMany: (input) => {
      batches.push(input);
      decisions.push(...input);
      return Effect.succeed(input.map(answerOf));
    },
    decisions,
    list: (input) => {
      const decision = answerOf(input);
      const visible = decision.outcome === 'ALLOWED' || decision.outcome === 'NEEDS_APPROVAL';
      return Effect.succeed(visible ? { decision, predicate: { groups: [] } } : { decision });
    },
    selectableAsks,
    selectableLegalEntities: (input) => {
      selectableAsks.push(input);
      return companies.selectableLegalEntities(input);
    },
    singleDecisions,
  };
  // The same gate a runtime asks: it already answers `decide`, `list` and `selectableLegalEntities`,
  // so binding it to a composition's ports changes nothing (the double reads no authority).
  return { ...gate, bound: gate };
};

/** A per-key answer map a suite may change between calls, e.g. to prove a revocation is rechecked. */
export const shellTestAnswers = (initial: Readonly<Record<string, ShellTestAccess>>) => ({ ...initial });

/** The trusted request scope a Shell suite asks its questions in (O66). */
export const shellTestScope = (input: {
  readonly correlationId?: string;
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}): OperationalScope => {
  const base = {
    authBindingId: `binding-${input.principalId}`,
    authContextRef: `session-${input.principalId}`,
    authMethod: 'session' as const,
    correlationId: input.correlationId ?? 'unit-correlation',
    principalId: input.principalId,
    tenantId: input.tenantId,
  };
  return Object.freeze(input.legalEntityId === undefined ? base : { ...base, legalEntityId: input.legalEntityId });
};
