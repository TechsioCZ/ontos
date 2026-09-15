import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PrivacyAffectedFactSchema,
  PrivacyIdentityChangeSchema,
  PrivacyIdentityReconciliationSchema,
  classifyPrivacyIdentityChange,
  resolvePrivacyAddressability,
} from '../../shared/domain/privacy-identity-reconciliation.ts';
import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const party = (resourceId: string) =>
  Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
    moduleId: 'party.registry' as const,
    resourceId,
    resourceType: 'party.registry.party' as const,
    tenantId,
  });
const change = {
  canonicalPartyRef: party('survivor'),
  changedAt: '2026-09-14T10:00:00Z',
  evidenceRefs: ['party-merge:1'],
  kind: 'PARTY_ALIAS' as const,
  sourceEventRef: 'party-event:merge-1',
  sourcePartyRef: party('absorbed'),
};
const consent = {
  factKind: 'CONSENT_DECISION' as const,
  factRef: 'privacy.consent:decision-1',
  originalPartyRef: party('absorbed'),
  provenanceRefs: ['action-invocation:1'],
  sourceDecisionRevision: 'revision-7',
};

describe('privacy identity reconciliation boundary', () => {
  it('requires explicit reconciliation for affected privacy facts', () => {
    expect(classifyPrivacyIdentityChange(change, [consent])).toBe('RECONCILIATION_REQUIRED');
    expect(classifyPrivacyIdentityChange(change, [])).toBe('NO_TRANSFER_REQUIRED');
  });

  it('keeps historical consent reference and provenance while resolving addressability', () => {
    const decodedChange = Schema.decodeUnknownSync(PrivacyIdentityChangeSchema)(change);
    const decodedFact = Schema.decodeUnknownSync(PrivacyAffectedFactSchema)(consent);
    expect(resolvePrivacyAddressability(decodedChange, decodedFact)).toEqual({
      canonicalPartyRef: party('survivor'),
      originalPartyRef: party('absorbed'),
    });
    expect(decodedFact.provenanceRefs).toEqual(['action-invocation:1']);
  });

  it('decodes a durable reconciliation contract without transferring authority', () => {
    const reconciliation = Schema.decodeUnknownSync(PrivacyIdentityReconciliationSchema)({
      affectedFacts: [consent],
      identityChange: change,
      outcome: 'RECONCILIATION_REQUIRED',
      reconciliationRef: {
        moduleId: 'privacy.core',
        resourceId: 'reconciliation:1',
        resourceType: 'privacy.core.identity-reconciliation',
        tenantId,
      },
      requiredOwnerChecks: ['privacy.consent'],
    });

    expect(reconciliation.affectedFacts[0]?.originalPartyRef).toEqual(party('absorbed'));
    expect(reconciliation.outcome).toBe('RECONCILIATION_REQUIRED');
  });

  it('rejects cross-tenant identity changes', () => {
    expect(() =>
      Schema.decodeUnknownSync(PrivacyIdentityChangeSchema)({
        ...change,
        canonicalPartyRef: { ...party('survivor'), tenantId: '10000000-0000-4000-8000-000000000002' },
      }),
    ).toThrow();
  });
});
