import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';

/*
 * The revision of a tenant's people intent: a digest of exactly the facts a people command is planned
 * on. The command service answers it with every read, and the store compares it again inside the write
 * transaction, under the tenant's people lock, so a plan whose view another change has overtaken is
 * refused instead of committed. Both sides compute it here, so they can never disagree on its shape.
 */

/** The fields of one membership row the revision covers. */
export interface PeopleRevisionMembership {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly validFrom: Date;
}

/** The fields of one assignment row the revision covers. */
export interface PeopleRevisionAssignment {
  readonly incarnationId: string;
  readonly roleRevisionId: string;
  readonly status: string;
}

/** The fields of one delegation row the revision covers. */
export interface PeopleRevisionDelegation {
  readonly id: string;
  readonly status: string;
}

/** The fields of one team place the revision covers. */
export interface PeopleRevisionTeamMember {
  readonly id: string;
  readonly teamId: string;
}

export interface PeopleRevisionInput {
  readonly assignments: readonly PeopleRevisionAssignment[];
  readonly delegations: readonly PeopleRevisionDelegation[];
  readonly memberships: readonly PeopleRevisionMembership[];
  readonly teamMembers: readonly PeopleRevisionTeamMember[];
}

/** Changes exactly when a membership, assignment, delegation or team place of the tenant changes. */
export const peopleRevisionOf = (intent: PeopleRevisionInput): string => {
  const lines = [
    ...intent.memberships.map(
      (membership) =>
        `membership ${membership.id} ${membership.kind} ${membership.status} ${membership.validFrom.toISOString()}`,
    ),
    ...intent.assignments.map(
      (assignment) => `assignment ${assignment.incarnationId} ${assignment.status} ${assignment.roleRevisionId}`,
    ),
    ...intent.delegations.map((delegation) => `delegation ${delegation.id} ${delegation.status}`),
    ...intent.teamMembers.map((member) => `team ${member.teamId} ${member.id}`),
  ].toSorted((left, right) => left.localeCompare(right));
  return Hex.encode(sha256(utf8ToBytes(lines.join('\n'))));
};
