// expect-count: 6
import { Schema } from 'effect';

// 1 — the B5 evidence shape: a TS-only vocabulary next to no codec at all.
export type ActionIdempotencyRule = 'optional' | 'required';

// 2 — three members, exported.
export type ActionAuditProfile = 'minimal' | 'sensitive' | 'standard';

// 3 — leading pipe, multi-line.
export type LegalEntityScope =
  | 'forbidden'
  | 'optional'
  | 'required';

// 4 — double quotes.
type OutboxFailureStatus = "dead" | "pending";

// 5 — the duplication message: `Schema.Literals` already owns this vocabulary here.
export const ModuleStateDecisionSchema = Schema.Literals(['approve', 'reject']);
export type ModuleStateDecision = 'approve' | 'reject';

// 6 — nullish members are noise, the vocabulary is still closed.
export type CanonicalOutcome = 'failure' | 'success' | null;

// not reported: derived from the Schema (the target shape).
export type ModuleStateDecisionDerived = typeof ModuleStateDecisionSchema.Type;
