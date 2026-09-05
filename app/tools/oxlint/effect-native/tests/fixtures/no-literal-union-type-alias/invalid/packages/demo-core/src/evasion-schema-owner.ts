// expect-count: 3
// The owning codec is bound through an aliased import, a submodule namespace import and a nested
// scope. Each alias below is still a TS-only vocabulary and must report.
import { Schema as S } from 'effect';
import * as Sch from 'effect/Schema';

export const OutboxFailureStatusSchema = S.Literals(['dead', 'pending']);
export type OutboxFailureStatus = 'dead' | 'pending';

export const ModuleStateDecisions = Sch.Literals(['allow', 'deny']);
export type ModuleStateDecision = 'allow' | 'deny';

export function build(): unknown {
  const AuditProfile = S.Literals(['minimal', 'sensitive', 'standard']);
  return AuditProfile;
}

export type AuditProfile = 'minimal' | 'sensitive' | 'standard';
