import { expect, it } from 'effect-rstest';

import { counterpartyReadRead } from '../../src/api/counterparty-read.read.ts';
import { duplicateCandidateDetailRead } from '../../src/api/duplicate-candidate-detail.read.ts';
import { partyContactPointDetailRead } from '../../src/api/party-contact-point-detail.read.ts';
import { partyContactPointsRead } from '../../src/api/party-contact-points.read.ts';
import { partyCorrectionRead } from '../../src/api/party-correction.read.ts';
import { partyDetailRead } from '../../src/api/party-detail.read.ts';
import { partyMatchDecisionRead } from '../../src/api/party-match-decision.read.ts';
import { partyMatchRead } from '../../src/api/party-match.read.ts';
import { partyMergeReadinessRead } from '../../src/api/party-merge-readiness.read.ts';
import { partyOfficialIdentifierDetailRead } from '../../src/api/party-official-identifier-detail.read.ts';
import { partyOfficialIdentifierHistoryRead } from '../../src/api/party-official-identifier-history.read.ts';
import { partyRelationshipDetailRead } from '../../src/api/party-relationship-detail.read.ts';
import { counterpartiesRead } from '../../src/search/counterparties.provider.ts';
import { partiesRead } from '../../src/search/parties.provider.ts';

/** Every governed read that answers personal or authority data, with the class its owner declares. */
const declaredFieldGroups = [
  {
    classes: { 'party.registry.party-identity.read': 'personal_data' },
    read: partyDetailRead,
  },
  {
    classes: { 'party.registry.contact-point-value.read': 'personal_data' },
    read: partyContactPointDetailRead,
  },
  {
    classes: { 'party.registry.contact-point-value.list': 'personal_data' },
    read: partyContactPointsRead,
  },
  {
    classes: { 'party.registry.official-identifier-value.read': 'personal_data' },
    read: partyOfficialIdentifierDetailRead,
  },
  {
    classes: { 'party.registry.official-identifier-value.read-history': 'personal_data' },
    read: partyOfficialIdentifierHistoryRead,
  },
  {
    classes: { 'party.registry.counterparty-identity.read': 'personal_data' },
    read: counterpartyReadRead,
  },
  {
    classes: { 'party.registry.identity-review-evidence.read': 'personal_data' },
    read: duplicateCandidateDetailRead,
  },
  {
    classes: {
      'party.registry.party-correction-authority.read': 'authority_metadata',
      'party.registry.party-correction-evidence.read': 'personal_data',
    },
    read: partyCorrectionRead,
  },
  {
    classes: { 'party.registry.party-match-decision-evidence.read': 'personal_data' },
    read: partyMatchDecisionRead,
  },
  {
    classes: { 'party.registry.party-search-identity.read': 'personal_data' },
    read: partiesRead,
  },
  {
    classes: { 'party.registry.counterparty-search-identity.read': 'personal_data' },
    read: counterpartiesRead,
  },
] as const;

it('declares a field group for every sensitive result path its read returns (O58, O19)', () => {
  for (const { classes, read } of declaredFieldGroups) {
    const groups = read.descriptor.accessFieldGroups ?? [];
    expect(groups.map((group) => group.key).toSorted()).toEqual(Object.keys(classes).toSorted());
    for (const group of groups) {
      expect(group.kind).toBe('field_read');
      // A field class switch is never a record scope: the parent declaration carries the selectors.
      expect(group.selectors).toEqual([]);
      // A read is never proposable, so a field read is run-only (O45).
      expect(group.modes).toEqual(['run']);
      // Every sensitive class carries a sensitive floor (O19).
      expect(group.risk).not.toBe('routine');
      expect(group.fields.length).toBeGreaterThan(0);
      expect(new Set(group.fields).size).toBe(group.fields.length);
      // SAFETY: the table above declares one class per group key this read declares, and the keys
      // were just compared, so the lookup is the group's own entry.
      expect(group.fieldClass).toBe(classes[group.key as keyof typeof classes]);
    }
  }
});

it('keeps every field group inside its own module and off its parent declaration key (O27, O58)', () => {
  for (const { read } of declaredFieldGroups) {
    const { accessDeclaration, accessFieldGroups = [] } = read.descriptor;
    expect(accessDeclaration).toBeDefined();
    for (const group of accessFieldGroups) {
      expect(group.key.startsWith('party.registry.')).toBe(true);
      expect(group.key).not.toBe(accessDeclaration?.key);
    }
  }
});

it('names the record a sensitive detail read is decided on, so a field grant rides its parent read (D14)', () => {
  // A detail or export read decides each group with the record it returns, so it must name it.
  const rowScoped = new Set(['list', 'report', 'search']);
  for (const { read } of declaredFieldGroups) {
    const { accessDeclaration, accessFieldGroups = [] } = read.descriptor;
    expect(accessFieldGroups.length).toBeGreaterThan(0);
    if (rowScoped.has(read.descriptor.accessKind)) {
      // A row-scoped read hands its rows to the gate's list predicate and names no single record (O25).
      expect(read.descriptor.accessTarget).toBeUndefined();
    } else if ((accessDeclaration?.selectors.length ?? 0) > 0) {
      // A record-scoped declaration decides its groups with the record the read returns (D14).
      expect(read.descriptor.accessTarget).toBeDefined();
    } else {
      // A scope-wide declaration is its own parent read and names no record (O74).
      expect(read.descriptor.accessTarget).toBeUndefined();
    }
  }
});

it('leaves reads whose result carries no personal field without a field group (negative control)', () => {
  // The Party relationship detail answers opaque references and a relationship reason, which O2 and
  // O8 keep out of personal_data, merge readiness answers references plus blocker codes, and the
  // match preview answers candidate references and evidence kinds only. A group here would invent a
  // class the owner does not have, so none of these reads declares one.
  for (const read of [partyRelationshipDetailRead, partyMergeReadinessRead, partyMatchRead]) {
    expect(read.descriptor.accessFieldGroups ?? []).toEqual([]);
  }
});
