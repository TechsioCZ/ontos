import { Schema } from 'effect';

import { RoleRevisionSchema, RoleSchema } from '../../model.ts';
import type { Role, RoleRevision } from '../../model.ts';

/**
 * A role creation the store already holds under the same IDs is the same request replayed when every
 * field it writes matches. The instant is the request's own clock, read again on every attempt, so a
 * retry carries a different one and it is not part of what the creation says.
 */
export const isReplayedRole = (stored: Role, planned: Role): boolean =>
  Schema.toEquivalence(RoleSchema)(stored, { ...planned, createdAt: stored.createdAt });

/** The same rule for the first revision of that role: its instant is the request's clock, not its content. */
export const isReplayedRoleRevision = (stored: RoleRevision, planned: RoleRevision): boolean =>
  Schema.toEquivalence(RoleRevisionSchema)(stored, { ...planned, createdAt: stored.createdAt });
