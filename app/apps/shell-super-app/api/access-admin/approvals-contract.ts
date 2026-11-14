import { AgentIdSchema, PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { DateTime, Schema } from 'effect';

/**
 * The vocabulary of "Ke schválení" that both the BFF and its Core seam speak: the proposal record it
 * reads, the witnesses a decision carries, the projected preview of the frozen command and the two
 * tagged failures a port can answer with.
 *
 * The holder and requester tags come from Schema, so an agent is never folded into the person it
 * works for and no second authority for `_tag` exists beside the contract (guarantee 4, A4/C2).
 */

/** Who proposed or holds a bound cell: a verified person, or the agent working for one. */
export const ApprovalRequesterSchema = Schema.Union([
  Schema.TaggedStruct('Principal', { principalId: PrincipalIdSchema }),
  Schema.TaggedStruct('Agent', { agentId: AgentIdSchema, principalId: PrincipalIdSchema }),
]);
export type ApprovalRequester = typeof ApprovalRequesterSchema.Type;

/** A mandate witness is always the approving person's own assignment, never an agent's (O63). */
export const ApprovalPrincipalHolderSchema = Schema.TaggedStruct('Principal', {
  principalId: PrincipalIdSchema,
});
export type ApprovalPrincipalHolder = typeof ApprovalPrincipalHolderSchema.Type;

export const APPROVAL_STATUSES = ['pending', 'approved', 'executed', 'rejected', 'lapsed', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalRecord {
  readonly approval?: { readonly approvedAt: Date; readonly approverId: string; readonly expiresAt: Date };
  readonly capabilityKey: string;
  readonly commandDigest: string;
  readonly createdAt: Date;
  readonly endedAt?: Date;
  readonly execution?: { readonly actionInvocationId: string; readonly executedAt: Date };
  readonly expiresAt: Date;
  readonly id: string;
  readonly rejectedBy?: string;
  readonly requester: ApprovalRequester;
  readonly scopeId: string;
  readonly status: ApprovalStatus;
  readonly target?: string;
  readonly tenantId: string;
}

/** A display precondition only. The owner's native lifecycle still performs the authoritative CAS. */
export const approvalRecordRevision = (record: ApprovalRecord): string =>
  [
    record.status,
    record.endedAt === undefined ? 0 : DateTime.toEpochMillis(DateTime.makeUnsafe(record.endedAt)),
    record.execution === undefined ? 0 : DateTime.toEpochMillis(DateTime.makeUnsafe(record.execution.executedAt)),
  ].join('.');

/** The exact assignment incarnation and grant cell that justified one part of a decision (O49). */
export interface ApprovalWitness {
  readonly assignmentIncarnationId: string;
  readonly capabilityKey: string;
  readonly grantIncarnationId: string;
  readonly holderId: ApprovalPrincipalHolder;
  readonly scopeId: string;
}

/** One resolved authority fact, with a stable reason code when it is negative. */
export interface ApprovalEligibility {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface ApprovalScopeView {
  readonly accessScopeId: string;
  readonly kind: 'company' | 'tenant';
  readonly legalEntityId?: string;
}

/** The server-rendered projection of the frozen command: field-filtered, never a payload source. */
export interface ApprovalCommandPreview {
  readonly actionKey: string;
  readonly capabilityKey: string;
  readonly digestShort: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  readonly frozenAt: Date;
  readonly redactedFieldCount: number;
  readonly target?: { readonly label?: string; readonly recordKey: string };
}

/* ------------------------------------------------------------------------------------------------
 * The failure vocabulary of the surface. Each is a Schema-owned tagged value, not a hand-written
 * class: the `_tag` is the contract, so a caller narrows with `Predicate.isTagged` and the wire never
 * sees an untyped throw.
 * ---------------------------------------------------------------------------------------------- */

/** A port failure: retryable, and therefore a 503 that is never reported as a denial. */
export const ApprovalPortUnavailableSchema = Schema.TaggedStruct('ApprovalPortUnavailable', {
  reason: Schema.String,
});
export type ApprovalPortUnavailable = typeof ApprovalPortUnavailableSchema.Type;

/** A decision Core refused; Core's own code travels through so the BFF never re-invents the rule. */
export const ApprovalCommandRefusedSchema = Schema.TaggedStruct('ApprovalCommandRefused', {
  code: Schema.String,
  reason: Schema.String,
  retryable: Schema.Boolean,
});
export type ApprovalCommandRefused = typeof ApprovalCommandRefusedSchema.Type;

export type ApprovalCommandFailure = ApprovalCommandRefused | ApprovalPortUnavailable;
