import { Schema } from 'effect';
import { assert, it } from 'effect-rstest';

import {
  duplicateCandidateCaseResourceDescriptor,
  makeDuplicateCandidateCaseRef,
  DuplicateCandidateCaseRefSchema,
} from '../../shared/resources/duplicate-candidate-case.ts';
import {
  partyCorrectionResourceDescriptor,
  makePartyCorrectionRef,
  PartyCorrectionRefSchema,
} from '../../shared/resources/party-correction.ts';
import {
  partyMatchDecisionResourceDescriptor,
  makePartyMatchDecisionRef,
  PartyMatchDecisionRefSchema,
} from '../../shared/resources/party-match-decision.ts';
import {
  partyOfficialIdentifierResourceDescriptor,
  PartyOfficialIdentifierRefSchema,
} from '../../shared/resources/party-official-identifier.ts';
import { makePartyOfficialIdentifierRef } from '../../src/services/party-official-identifier-reference.ts';

const resources = [
  {
    descriptor: duplicateCandidateCaseResourceDescriptor,
    makeRef: makeDuplicateCandidateCaseRef,
    schema: DuplicateCandidateCaseRefSchema,
    slug: 'duplicate-candidate-case',
  },
  {
    descriptor: partyCorrectionResourceDescriptor,
    makeRef: makePartyCorrectionRef,
    schema: PartyCorrectionRefSchema,
    slug: 'party-correction',
  },
  {
    descriptor: partyMatchDecisionResourceDescriptor,
    makeRef: makePartyMatchDecisionRef,
    schema: PartyMatchDecisionRefSchema,
    slug: 'party-match-decision',
  },
  {
    descriptor: partyOfficialIdentifierResourceDescriptor,
    makeRef: makePartyOfficialIdentifierRef,
    schema: PartyOfficialIdentifierRefSchema,
    slug: 'party-official-identifier',
  },
];

for (const { descriptor, makeRef, schema, slug } of resources) {
  it(`${slug} retains its own resource identity and timeline-only capabilities`, () => {
    const tenantId = '10000000-0000-4000-8000-000000000001';
    const reference = makeRef(tenantId, 'resource-1');
    assert.deepEqual(reference, {
      moduleId: 'party.registry',
      resourceId: 'resource-1',
      resourceType: `party.registry.${slug}`,
      tenantId,
    });
    assert.equal(Schema.is(schema)(reference), true);
    for (const other of resources.filter((resource) => resource.slug !== slug)) {
      assert.equal(Schema.is(schema)(other.makeRef(tenantId, 'resource-1')), false);
    }
    assert.equal(Schema.is(schema)({ ...reference, resourceId: '' }), false);
    assert.equal(Schema.is(schema)({ ...reference, tenantId: 'not-a-uuid' }), false);
    assert.equal(descriptor.key, reference.resourceType);
    assert.equal(descriptor.owningModuleId, reference.moduleId);
    assert.equal(descriptor.description, `${descriptor.label} resource.`);
    assert.deepEqual(descriptor.capabilities, {
      graphVisible: false,
      linkable: false,
      mediaAttachable: false,
      searchable: false,
      timelineVisible: true,
    });
  });
}
