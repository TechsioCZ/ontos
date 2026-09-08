import { addContactPointAction } from '../src/actions/add-contact-point.action.ts';
import { addPartyOfficialIdentifierAction } from '../src/actions/add-party-official-identifier.action.ts';
import { archivePartyAction } from '../src/actions/archive-party.action.ts';
import { confirmDuplicatePartiesAction } from '../src/actions/confirm-duplicate-parties.action.ts';
import { correctPartyFactAction } from '../src/actions/correct-party-fact.action.ts';
import { counterpartyCreateAction } from '../src/actions/counterparty-create.action.ts';
import { counterpartyRoleAddAction } from '../src/actions/counterparty-role-add.action.ts';
import { counterpartyRoleEndAction } from '../src/actions/counterparty-role-end.action.ts';
import { createPartyRelationshipAction } from '../src/actions/create-party-relationship.action.ts';
import { createPartyAction } from '../src/actions/create-party.action.ts';
import { dismissDuplicateCandidateAction } from '../src/actions/dismiss-duplicate-candidate.action.ts';
import { endContactPointAction } from '../src/actions/end-contact-point.action.ts';
import { endPartyOfficialIdentifierAction } from '../src/actions/end-party-official-identifier.action.ts';
import { endPartyRelationshipAction } from '../src/actions/end-party-relationship.action.ts';
import { markDuplicateCandidateNeedsEvidenceAction } from '../src/actions/mark-duplicate-candidate-needs-evidence.action.ts';
import { matchPartyAction } from '../src/actions/match-party.action.ts';
import { requestSearchRebuildAction } from '../src/actions/request-search-rebuild.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../src/actions/resolve-duplicate-candidate-create.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../src/actions/resolve-duplicate-candidate-match.action.ts';
import { unarchivePartyAction } from '../src/actions/unarchive-party.action.ts';
import { updateContactPointAction } from '../src/actions/update-contact-point.action.ts';
import { updatePartyOfficialIdentifierAction } from '../src/actions/update-party-official-identifier.action.ts';
import { updatePartyRelationshipAction } from '../src/actions/update-party-relationship.action.ts';
import { updatePartyAction } from '../src/actions/update-party.action.ts';

// New generated registrations have one sorted owner-local composition slot. The HTTP group stays
// explicit in party-command-server.ts; problem typing derives from this same catalog.
export const partyCommandRegistrations = {
  addContactPoint: addContactPointAction,
  addPartyOfficialIdentifier: addPartyOfficialIdentifierAction,
  archiveParty: archivePartyAction,
  confirmDuplicateParties: confirmDuplicatePartiesAction,
  correctPartyFact: correctPartyFactAction,
  counterpartyCreate: counterpartyCreateAction,
  counterpartyRoleAdd: counterpartyRoleAddAction,
  counterpartyRoleEnd: counterpartyRoleEndAction,
  createParty: createPartyAction,
  createPartyRelationship: createPartyRelationshipAction,
  dismissDuplicateCandidate: dismissDuplicateCandidateAction,
  endContactPoint: endContactPointAction,
  endPartyOfficialIdentifier: endPartyOfficialIdentifierAction,
  endPartyRelationship: endPartyRelationshipAction,
  markDuplicateCandidateNeedsEvidence:
    markDuplicateCandidateNeedsEvidenceAction,
  matchParty: matchPartyAction,
  requestSearchRebuild: requestSearchRebuildAction,
  resolveDuplicateCandidateCreate: resolveDuplicateCandidateCreateAction,
  resolveDuplicateCandidateMatch: resolveDuplicateCandidateMatchAction,
  unarchiveParty: unarchivePartyAction,
  updateContactPoint: updateContactPointAction,
  updateParty: updatePartyAction,
  updatePartyOfficialIdentifier: updatePartyOfficialIdentifierAction,
  updatePartyRelationship: updatePartyRelationshipAction,
} as const;
