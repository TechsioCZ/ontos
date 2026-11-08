import type { AccessDeclaration, LegalEntityScope } from '@app/core-runtime';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { Schema } from 'effect';
import type { Effect } from 'effect';

/**
 * The one thing every Shell surface asks of the access gate: the answer the caller acts on. The
 * Shell adds exactly one state of its own — `selection_required`, which is not an engine answer but
 * the consequence of asking a company-scoped capability without a selected company (O28) — and it
 * reads that state from the gate's own reason code instead of guessing at the company's absence.
 */
const ShellAccessOutcomeSchema = Schema.Literals(['allowed', 'forbidden', 'selection_required', 'unavailable']);
export type ShellAccessOutcome = typeof ShellAccessOutcomeSchema.Type;

type ShellAccessDecision = Effect.Success<ReturnType<AccessDecisionService['decide']>>;
export type { ShellAccessDecision };

/**
 * The gate questions a Shell surface asks, as a plain port: the composition hands its sources the
 * questions it needs rather than the whole enforcement service. A record-scoped declaration (one that
 * names selectors) is admitted through `list`, never a targetless `decide` (R5b-4): the list gate
 * answers with a predicate instead of refusing `deny.target_required`.
 */
export interface ShellAccessGate {
  readonly decide: (input: GateInput) => Effect.Effect<ShellAccessDecision>;
  readonly decideMany: (input: readonly GateInput[]) => Effect.Effect<readonly ShellAccessDecision[]>;
  readonly list: AccessDecisionService['list'];
}

/** The gate's reason for a capability asked in a context it is not scoped to. */
const SCOPE_MISMATCH = 'deny.scope_mismatch';

/** A company-scoped capability was asked with no selected company: the Shell must ask for one. */
export const isScopeMismatch = (decision: ShellAccessDecision): boolean =>
  decision.outcome === 'DENIED' && decision.reasons.some(({ code }) => code === SCOPE_MISMATCH);

/** A contribution a person may now use, or one they may not use yet but may still be shown. */
export const isVisibleDecision = (decision: ShellAccessDecision): boolean =>
  decision.outcome === 'ALLOWED' || decision.outcome === 'NEEDS_APPROVAL';

/**
 * The v2 scope of a Shell contribution (O7, O12, O28). A contribution carries its own declaration
 * but no `legalEntityScope`, so the Shell applies the one rule it can state: access administration
 * always runs in the tenant context and works without a selected company, and everything else is
 * company-owned business data. A contribution without a declaration is asked in the stricter scope,
 * so the gate refuses it (`deny.declaration_missing`) instead of the Shell inferring anything (O62).
 */
export const shellLegalEntityScope = (declaration: AccessDeclaration | undefined): LegalEntityScope =>
  declaration !== undefined && declaration.kind === 'admin' ? 'optional' : 'required';

/**
 * One gate answer as the Shell's own outcome. `NEEDS_APPROVAL` never reaches a read-backed surface
 * (a read has no proposal mode, O42/O45), so it is refused exactly like a denial.
 */
export const shellAccessOutcome = (decision: ShellAccessDecision): ShellAccessOutcome => {
  if (decision.outcome === 'ALLOWED') {
    return 'allowed';
  }
  if (decision.outcome === 'UNAVAILABLE') {
    return 'unavailable';
  }
  return isScopeMismatch(decision) ? 'selection_required' : 'forbidden';
};
