import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Match, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { AccessChangeItemIdSchema, AssignmentIncarnationIdSchema, RoleIdSchema } from '../ids.ts';
import type { AccessChangeItemId, AccessScopeId, PrincipalId, RoleId } from '../ids.ts';
import type { Assignment, Holder } from '../model.ts';
import { HolderSchema } from '../model.ts';
import { compareText } from './compare.ts';

/**
 * The holder preview administrators see before deciding. It is a *preview*: it never grants, it
 * only names the assignments that the decision would reach. Its fingerprint makes a stale preview
 * detectable instead of silently wrong (D7b).
 */
export const AccessPreviewFingerprintSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export type AccessPreviewFingerprint = typeof AccessPreviewFingerprintSchema.Type;

export const AffectedHolderSchema = Schema.Struct({
  assignmentIncarnationId: AssignmentIncarnationIdSchema,
  holder: HolderSchema,
  roleId: RoleIdSchema,
});
export type AffectedHolder = typeof AffectedHolderSchema.Type;

export const ChangeItemPreviewSchema = Schema.Struct({
  holders: Schema.Array(AffectedHolderSchema),
  itemId: AccessChangeItemIdSchema,
  roleIds: Schema.Array(RoleIdSchema).check(Schema.isUnique()),
});
export type ChangeItemPreview = typeof ChangeItemPreviewSchema.Type;

export const AdoptionPreviewSchema = Schema.Struct({
  agentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fingerprint: AccessPreviewFingerprintSchema,
  /** Every affected assignment once, across all items of the decision. */
  holders: Schema.Array(AffectedHolderSchema),
  humanCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  items: Schema.Array(ChangeItemPreviewSchema),
});
export type AdoptionPreview = typeof AdoptionPreviewSchema.Type;

/** Who a preview names: an item and the roles the decision would edit for it. */
export interface AdoptionPreviewItem {
  readonly itemId: AccessChangeItemId;
  readonly roleIds: readonly RoleId[];
}

export interface AdoptionPreviewInput {
  readonly assignments: readonly Assignment[];
  readonly at: Date;
  readonly items: readonly AdoptionPreviewItem[];
}

/**
 * An assignment reaches a holder only while it is active and inside its own period. A revoked,
 * expired or future assignment is never named in a preview, so adoption cannot claim it either.
 */
export const isActiveAssignment = (assignment: Assignment, at: Date): boolean =>
  assignment.status === 'active' &&
  assignment.validFrom <= at &&
  (assignment.validUntil === undefined || at < assignment.validUntil);

export const isAgentHolder = (holder: Holder): boolean =>
  Match.value(holder).pipe(Match.tags({ Agent: () => true, Principal: () => false }), Match.exhaustive);

/** The people a decision reaches. An agent holder is never one of them (D2). */
export const previewPrincipals = (preview: AdoptionPreview): readonly PrincipalId[] =>
  preview.holders.flatMap(({ holder }) =>
    Match.value(holder).pipe(
      Match.tags({ Agent: () => [], Principal: ({ principalId }) => [principalId] }),
      Match.exhaustive,
    ),
  );

export const previewHasAgent = (preview: AdoptionPreview): boolean =>
  preview.holders.some(({ holder }) => isAgentHolder(holder));

/** The assignments a preview names: exactly the set a decision reaches, with their own scopes. */
export const previewAssignments = (
  preview: AdoptionPreview,
  assignments: readonly Assignment[],
): readonly Assignment[] => {
  const named = new Set(preview.holders.map(({ assignmentIncarnationId }) => assignmentIncarnationId));
  return assignments.filter(({ incarnationId }) => named.has(incarnationId));
};

/** The scopes a decision reaches, which a delegation must cover with its own scope (R2-H4). */
export const previewScopeIds = (
  preview: AdoptionPreview,
  assignments: readonly Assignment[],
): readonly AccessScopeId[] => previewAssignments(preview, assignments).map(({ scopeId }) => scopeId);

const previewItem = (item: AdoptionPreviewItem, assignments: readonly Assignment[], at: Date): ChangeItemPreview => {
  const roleIds = [...new Set(item.roleIds)].toSorted(compareText);
  const roles = new Set(roleIds);
  const holders: AffectedHolder[] = [];
  for (const assignment of assignments) {
    if (roles.has(assignment.roleId) && isActiveAssignment(assignment, at)) {
      holders.push({
        assignmentIncarnationId: assignment.incarnationId,
        holder: assignment.holder,
        roleId: assignment.roleId,
      });
    }
  }
  holders.sort(
    (left, right) =>
      compareText(left.roleId, right.roleId) ||
      compareText(left.assignmentIncarnationId, right.assignmentIncarnationId),
  );
  return Object.freeze({ holders: Object.freeze(holders), itemId: item.itemId, roleIds: Object.freeze(roleIds) });
};

const uniqueHolders = (items: readonly ChangeItemPreview[]): readonly AffectedHolder[] => {
  const byIncarnation = new Map<string, AffectedHolder>();
  for (const { holders } of items) {
    for (const holder of holders) {
      byIncarnation.set(holder.assignmentIncarnationId, holder);
    }
  }
  const ordered: AffectedHolder[] = [];
  for (const incarnationId of [...byIncarnation.keys()].toSorted(compareText)) {
    const holder = byIncarnation.get(incarnationId);
    if (holder !== undefined) {
      ordered.push(holder);
    }
  }
  return ordered;
};

/**
 * A preview is stale when the *membership* of the affected set changed, not when a label did, so
 * the fingerprint covers the items, their target roles and every affected assignment incarnation.
 */
const previewFingerprint = (items: readonly ChangeItemPreview[]): AccessPreviewFingerprint => {
  const lines: string[] = [];
  for (const { holders, itemId, roleIds } of items) {
    lines.push(`item:${itemId}:${roleIds.join('+')}`);
    for (const { assignmentIncarnationId, roleId } of holders) {
      lines.push(`holder:${itemId}:${roleId}:${assignmentIncarnationId}`);
    }
  }
  return Hex.encode(sha256(utf8ToBytes(lines.join('\n'))));
};

/**
 * The affected-holder preview for one decision. Deterministic for a given intent, so the same
 * intent always yields the same fingerprint and any change yields a different one.
 */
export const previewAdoption = (input: AdoptionPreviewInput): AdoptionPreview => {
  const items = input.items
    .map((item) => previewItem(item, input.assignments, input.at))
    .toSorted((left, right) => compareText(left.itemId, right.itemId));
  const holders = uniqueHolders(items);
  let agentCount = 0;
  for (const { holder } of holders) {
    if (isAgentHolder(holder)) {
      agentCount += 1;
    }
  }
  return Object.freeze({
    agentCount,
    fingerprint: previewFingerprint(items),
    holders: Object.freeze(holders),
    humanCount: holders.length - agentCount,
    items: Object.freeze(items),
  });
};

/** The comparison every decision makes: a preview that no longer matches the intent is refused. */
export const samePreview = (left: AdoptionPreview, right: AdoptionPreview): boolean =>
  left.fingerprint === right.fingerprint;
