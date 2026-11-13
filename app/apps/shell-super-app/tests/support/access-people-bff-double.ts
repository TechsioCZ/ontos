import { Effect } from 'effect';

import type { AccessPeopleBffService } from '../../api/access-admin/people.ts';

export { AccessPeopleBff } from '../../api/access-admin/people.ts';

const unused = (name: string) => () => Effect.die(`${name} is not asked in this suite`);

/** The People BFF a suite never reaches: an agent change that is not a role change reads and writes no role. */
export const unusedAccessPeopleBff: AccessPeopleBffService = {
  admitMember: unused('admitMember'),
  agentRoles: unused('agentRoles'),
  assign: unused('assign'),
  assignAgentRole: unused('assignAgentRole'),
  assignments: unused('assignments'),
  createDelegation: unused('createDelegation'),
  endMembership: unused('endMembership'),
  list: unused('list'),
  options: unused('options'),
  revokeAgentAssignment: unused('revokeAgentAssignment'),
  revokeAssignment: unused('revokeAssignment'),
  revokeDelegation: unused('revokeDelegation'),
  setTeamMembership: unused('setTeamMembership'),
  transferOwnership: unused('transferOwnership'),
};
