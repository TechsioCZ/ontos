import { Schema } from 'effect';
import { assert, it } from 'effect-rstest';

import * as duplicateCase from '../../shared/resources/duplicate-candidate-case.ts';
import * as correction from '../../shared/resources/party-correction.ts';
import * as matchDecision from '../../shared/resources/party-match-decision.ts';
import * as identifier from '../../shared/resources/party-official-identifier.ts';
import { makePartyOfficialIdentifierRef } from '../../src/services/party-official-identifier-reference.ts';

const resources = [
  {
    descriptor: duplicateCase.duplicateCandidateCaseResourceDescriptor,
    makeRef: duplicateCase.makeDuplicateCandidateCaseRef,
    schema: duplicateCase.DuplicateCandidateCaseRefSchema,
    slug: 'duplicate-candidate-case',
  },
  {
    descriptor: correction.partyCorrectionResourceDescriptor,
    makeRef: correction.makePartyCorrectionRef,
    schema: correction.PartyCorrectionRefSchema,
    slug: 'party-correction',
  },
  {
    descriptor: matchDecision.partyMatchDecisionResourceDescriptor,
    makeRef: matchDecision.makePartyMatchDecisionRef,
    schema: matchDecision.PartyMatchDecisionRefSchema,
    slug: 'party-match-decision',
  },
  {
    descriptor: identifier.partyOfficialIdentifierResourceDescriptor,
    makeRef: makePartyOfficialIdentifierRef,
    schema: identifier.PartyOfficialIdentifierRefSchema,
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
