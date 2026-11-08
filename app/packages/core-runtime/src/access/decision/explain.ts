import type { CapabilityKey, PrincipalId, RoleId } from '../ids.ts';
import type { AccessMode, CellSelector, DecisionOutcome } from '../model.ts';
import type { AccessDecision, DecisionCapabilityPolicy, StructuralAuthorityEvidence } from './contract.ts';
import { withOptional } from './optional.ts';

/** One piece of authority shown by "Proč?": who gave what, through which role, until when. */
export interface ExplainedAuthority {
  readonly assignedAt: Date;
  readonly assignedBy: PrincipalId;
  readonly capabilityKey: CapabilityKey;
  readonly deadline?: Date;
  readonly mode: AccessMode;
  readonly roleId: RoleId;
  readonly roleLabel?: string;
  readonly selector: CellSelector['_tag'];
  readonly side: 'agent' | 'principal';
}

export interface ExplainAccessInput {
  readonly decision: AccessDecision;
  readonly grantableBy?: readonly PrincipalId[];
  readonly policy: DecisionCapabilityPolicy;
  readonly roleLabels?: ReadonlyMap<RoleId, string>;
}

/**
 * Structured "Proč?" answer. It carries codes and evidence only; the product wording and the
 * "request access" affordance are rendered by the UI. Admin screens work in tenant context and need
 * no business-data access (O28).
 */
export interface AccessExplanation {
  readonly admissionDeadline?: Date;
  readonly authority: readonly ExplainedAuthority[];
  /** Declared field class, so the UI can name the sensitive group that is being asked for. */
  readonly fieldClass?: string;
  readonly grantableBy: readonly PrincipalId[];
  readonly outcome: DecisionOutcome;
  readonly reasonCodes: readonly string[];
  /** True for DENIED and NEEDS_APPROVAL: the caller can show "request access" or "propose". */
  readonly requestable: boolean;
  /** The exact structural management path, when an admin key needs no adopted role cell. */
  readonly structuralAuthority?: StructuralAuthorityEvidence;
}

const explainedAuthority = (
  item: AccessDecision['evidence'][number],
  roleLabels: ReadonlyMap<RoleId, string> | undefined,
): ExplainedAuthority =>
  withOptional(
    withOptional(
      {
        assignedAt: item.assignedAt,
        assignedBy: item.assignedBy,
        capabilityKey: item.witness.capabilityKey,
        mode: item.mode,
        roleId: item.roleId,
        selector: item.selector,
        side: item.side,
      },
      'deadline',
      item.deadline,
    ),
    'roleLabel',
    roleLabels?.get(item.roleId),
  );

export const explainAccess = ({ decision, grantableBy, policy, roleLabels }: ExplainAccessInput): AccessExplanation =>
  withOptional(
    withOptional(
      withOptional(
        {
          authority: decision.evidence.map((item) => explainedAuthority(item, roleLabels)),
          grantableBy: grantableBy ?? [],
          outcome: decision.outcome,
          reasonCodes: decision.reasons.map(({ code }) => code),
          requestable: decision.outcome === 'DENIED' || decision.outcome === 'NEEDS_APPROVAL',
        },
        'structuralAuthority',
        decision.structuralEvidence,
      ),
      'admissionDeadline',
      decision.admissionDeadline,
    ),
    'fieldClass',
    policy.fieldClass,
  );
