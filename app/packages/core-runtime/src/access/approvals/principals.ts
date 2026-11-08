import { Result, Schema } from 'effect';

import type { PrincipalId } from '../ids.ts';
import { ApprovalRefusedError } from './errors.ts';

/**
 * The principal kinds Core can resolve. v2 accepts only verified people and agents as subjects, so
 * service, integration and system workloads never appear in a v2 decision, grant or approval (O46).
 */
export const RESOLVED_PRINCIPAL_KINDS = ['agent', 'human', 'integration', 'service', 'system'] as const;
export type ResolvedPrincipalKind = (typeof RESOLVED_PRINCIPAL_KINDS)[number];

/** A workload keeps its legacy or owner-local classification; it is never a v2 subject (O29, O46). */
export const V2SubjectKindSchema = Schema.Literals(['agent', 'human']);
/** The actor tag a v2 subject kind implies, or undefined for a workload. */
export const subjectActorTag = (kind: ResolvedPrincipalKind): 'Agent' | 'Principal' | undefined => {
  if (!Schema.is(V2SubjectKindSchema)(kind)) {
    return undefined;
  }
  return kind === 'agent' ? 'Agent' : 'Principal';
};

const humanProvenance = Symbol('VerifiedHumanPrincipal');

/**
 * A person, proven from the resolved principal row. The proof cannot be built outside this module,
 * so no code path can approve on behalf of an agent, a service, an integration or a system workload.
 */
export interface VerifiedHumanPrincipal {
  readonly [humanProvenance]: true;
  readonly principalId: PrincipalId;
}

export const verifyHumanPrincipal = (input: {
  readonly principalId: PrincipalId;
  readonly principalKind: ResolvedPrincipalKind;
}): Result.Result<VerifiedHumanPrincipal, ApprovalRefusedError> => {
  if (input.principalKind !== 'human') {
    return Result.fail(
      new ApprovalRefusedError({
        code: 'approver_not_human',
        reason: 'Only a verified person approves; an agent or a workload never does',
      }),
    );
  }
  const proof: VerifiedHumanPrincipal = { [humanProvenance]: true, principalId: input.principalId };
  return Result.succeed(Object.freeze(proof));
};
