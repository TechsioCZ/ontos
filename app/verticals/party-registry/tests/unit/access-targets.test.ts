import { Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { addPartyOfficialIdentifierAction } from '../../src/actions/add-party-official-identifier.action.ts';
import { archiveOrganizationEngagementAction } from '../../src/actions/archive-organization-engagement.action.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import { archivePersonEngagementAction } from '../../src/actions/archive-person-engagement.action.ts';
import { confirmDuplicatePartiesAction } from '../../src/actions/confirm-duplicate-parties.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { counterpartyRoleAddAction } from '../../src/actions/counterparty-role-add.action.ts';
import { counterpartyRoleEndAction } from '../../src/actions/counterparty-role-end.action.ts';
import { dismissDuplicateCandidateAction } from '../../src/actions/dismiss-duplicate-candidate.action.ts';
import { endContactPointAction } from '../../src/actions/end-contact-point.action.ts';
import { endPartyOfficialIdentifierAction } from '../../src/actions/end-party-official-identifier.action.ts';
import { endPartyRelationshipAction } from '../../src/actions/end-party-relationship.action.ts';
import { executePrivacyMeasureAction } from '../../src/actions/execute-privacy-measure.action.ts';
import { markDuplicateCandidateNeedsEvidenceAction } from '../../src/actions/mark-duplicate-candidate-needs-evidence.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { unarchiveOrganizationEngagementAction } from '../../src/actions/unarchive-organization-engagement.action.ts';
import { unarchivePartyAction } from '../../src/actions/unarchive-party.action.ts';
import { unarchivePersonEngagementAction } from '../../src/actions/unarchive-person-engagement.action.ts';
import { updateContactPointAction } from '../../src/actions/update-contact-point.action.ts';
import { updatePartyOfficialIdentifierAction } from '../../src/actions/update-party-official-identifier.action.ts';
import { updatePartyRelationshipAction } from '../../src/actions/update-party-relationship.action.ts';
import { updatePartyAction } from '../../src/actions/update-party.action.ts';
import { counterpartyReadRead } from '../../src/api/counterparty-read.read.ts';
import { counterpartyRoleHistoryRead } from '../../src/api/counterparty-role-history.read.ts';
import { duplicateCandidateDetailRead } from '../../src/api/duplicate-candidate-detail.read.ts';
import { organizationEngagementProfileRead } from '../../src/api/organization-engagement-profile.read.ts';
import { partyContactPointDetailRead } from '../../src/api/party-contact-point-detail.read.ts';
import { partyContactPointsRead } from '../../src/api/party-contact-points.read.ts';
import { partyCorrectionRead } from '../../src/api/party-correction.read.ts';
import { partyDetailRead } from '../../src/api/party-detail.read.ts';
import { partyMatchDecisionRead } from '../../src/api/party-match-decision.read.ts';
import { partyMergeReadinessRead } from '../../src/api/party-merge-readiness.read.ts';
import { partyOfficialIdentifierDetailRead } from '../../src/api/party-official-identifier-detail.read.ts';
import { partyOfficialIdentifierHistoryRead } from '../../src/api/party-official-identifier-history.read.ts';
import { partyRelationshipDetailRead } from '../../src/api/party-relationship-detail.read.ts';
import { personEngagementProfileRead } from '../../src/api/person-engagement-profile.read.ts';
import { privacyMeasureExecutionRead } from '../../src/api/privacy-measure-execution.read.ts';
import { counterpartiesRead } from '../../src/search/counterparties.provider.ts';
import { partiesRead } from '../../src/search/parties.provider.ts';

/**
 * Every record-scoped declaration names the immutable record the gate must decide (O9, O27), so a
 * capability granted on one record can never authorise another. A row-scoped read instead hands its
 * rows to the gate's list predicate (O25), and the four reads that cannot derive one record stay
 * scope-wide — the last assertions document which and why, so a later lane cannot add a target that
 * names a record the request does not carry.
 */
const recordScoped = [
  updatePartyAction.descriptor.accessTarget,
  archivePartyAction.descriptor.accessTarget,
  unarchivePartyAction.descriptor.accessTarget,
  addContactPointAction.descriptor.accessTarget,
  updateContactPointAction.descriptor.accessTarget,
  endContactPointAction.descriptor.accessTarget,
  addPartyOfficialIdentifierAction.descriptor.accessTarget,
  updatePartyOfficialIdentifierAction.descriptor.accessTarget,
  endPartyOfficialIdentifierAction.descriptor.accessTarget,
  updatePartyRelationshipAction.descriptor.accessTarget,
  endPartyRelationshipAction.descriptor.accessTarget,
  counterpartyRoleAddAction.descriptor.accessTarget,
  counterpartyRoleEndAction.descriptor.accessTarget,
  archivePersonEngagementAction.descriptor.accessTarget,
  unarchivePersonEngagementAction.descriptor.accessTarget,
  archiveOrganizationEngagementAction.descriptor.accessTarget,
  unarchiveOrganizationEngagementAction.descriptor.accessTarget,
  confirmDuplicatePartiesAction.descriptor.accessTarget,
  dismissDuplicateCandidateAction.descriptor.accessTarget,
  markDuplicateCandidateNeedsEvidenceAction.descriptor.accessTarget,
  resolveDuplicateCandidateCreateAction.descriptor.accessTarget,
  resolveDuplicateCandidateMatchAction.descriptor.accessTarget,
  correctPartyFactAction.descriptor.accessTarget,
  partyDetailRead.descriptor.accessTarget,
  counterpartyReadRead.descriptor.accessTarget,
  counterpartyRoleHistoryRead.descriptor.accessTarget,
  duplicateCandidateDetailRead.descriptor.accessTarget,
  organizationEngagementProfileRead.descriptor.accessTarget,
  personEngagementProfileRead.descriptor.accessTarget,
  partyContactPointDetailRead.descriptor.accessTarget,
  partyCorrectionRead.descriptor.accessTarget,
  partyOfficialIdentifierDetailRead.descriptor.accessTarget,
  partyRelationshipDetailRead.descriptor.accessTarget,
];

it('derives the record of every record-scoped declaration from the payload the caller sent', () => {
  for (const resolver of recordScoped) {
    expect(Predicate.isFunction(resolver)).toBe(true);
  }
});

it('leaves the reads that cannot name one record scope-wide instead of inventing a record key', () => {
  const noSingleRecord = [
    // Addressed by the Privacy coordinator's measure id, which is not an OntOS record UUID (O9).
    executePrivacyMeasureAction.descriptor.accessTarget,
    // Addressed by the decision record or its Action invocation, so not always a record.
    partyMatchDecisionRead.descriptor.accessTarget,
    // Names two or more Parties, and one target cannot express the conjunction of both ends (O11).
    partyMergeReadinessRead.descriptor.accessTarget,
    // Addressed by the caller's idempotency key, not by an immutable record id (O2, O9).
    privacyMeasureExecutionRead.descriptor.accessTarget,
  ];
  for (const resolver of noSingleRecord) {
    expect(resolver).toBeUndefined();
  }
  // A read that cannot name one record is a scope-wide declaration, never a record-scoped one whose
  // target would be missing: the field groups it carries ride its own scope-wide decision (O74).
  expect(partyMatchDecisionRead.descriptor.accessDeclaration?.selectors).toEqual([]);
  // The Party Registry privacy measure worker is the only module that calls these two, for a requester it relays.
  expect(executePrivacyMeasureAction.descriptor.accessActor).toEqual({
    callers: ['party-registry'],
    reason: expect.any(String),
    subject: 'identity',
  });
  expect(privacyMeasureExecutionRead.descriptor.accessActor).toEqual({
    callers: ['party-registry'],
    reason: expect.any(String),
    subject: 'identity',
  });
});

it('leaves row-scoped reads and search providers to the gate list predicate', () => {
  const rowScoped = [
    partyContactPointsRead.descriptor.accessTarget,
    partyOfficialIdentifierHistoryRead.descriptor.accessTarget,
    partiesRead.descriptor.accessTarget,
    counterpartiesRead.descriptor.accessTarget,
  ];
  for (const resolver of rowScoped) {
    expect(resolver).toBeUndefined();
  }
});
