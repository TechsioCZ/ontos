import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  LegalEntityRefSchema,
  PrivacyResponsibilityAssignmentSchema,
  ResponsibilityRoleHolderSchema,
} from '../../shared/domain/privacy-responsibility-assignment.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principal = { principalId: '20000000-0000-4000-8000-000000000001', tenantId } as const;
const assignmentRef = {
  moduleId: 'privacy.core' as const,
  resourceId: 'assignment-1',
  resourceType: 'privacy.core.privacy-responsibility-assignment' as const,
  tenantId,
};
const completeAssignment = {
  actor: principal,
  assignmentRef,
  effectiveFrom: '2026-09-14T10:00:00Z',
  effectiveTo: null,
  provenance: {
    decisionEvidenceRefs: ['evidence:arrangement-1'],
    reason: 'Controller arrangement approved for this scope',
    recordedAt: '2026-09-14T10:00:00Z',
  },
  role: 'CONTROLLER' as const,
  scopeRef: { scopeId: 'scope-1', scopeType: 'privacy.processing-scope' as const },
};

describe('privacy responsibility assignments', () => {
  it('keeps legal entity and party identity references distinctly typed', () => {
    const legalEntity = {
      moduleId: 'core.identity' as const,
      resourceId: 'legal-entity-1',
      resourceType: 'core.identity.legal-entity' as const,
      tenantId,
    };
    expect(Schema.decodeUnknownSync(LegalEntityRefSchema)(legalEntity)).toEqual(legalEntity);
    expect(() =>
      Schema.decodeUnknownSync(ResponsibilityRoleHolderSchema)({ holder: legalEntity, holderKind: 'PARTY' }),
    ).toThrow();
  });

  it('represents multiple controllers as explicit independent assignments', () => {
    const base = {
      assignmentRef,
      effectiveFrom: '2026-09-14T10:00:00Z',
      effectiveTo: null,
      provenance: {
        decisionEvidenceRefs: ['evidence:arrangement-1'],
        reason: 'Joint controller arrangement approved for this scope',
        recordedAt: '2026-09-14T10:00:00Z',
      },
      scopeRef: { scopeId: 'scope-1', scopeType: 'privacy.processing-scope' as const },
    };
    const assignments = [
      {
        ...base,
        actor: principal,
        assignmentRef: { ...assignmentRef, resourceId: 'assignment-1' },
        holder: {
          holder: {
            moduleId: 'core.identity' as const,
            resourceId: 'le-1',
            resourceType: 'core.identity.legal-entity' as const,
            tenantId,
          },
          holderKind: 'LEGAL_ENTITY' as const,
        },
        role: 'CONTROLLER' as const,
      },
      {
        ...base,
        actor: principal,
        assignmentRef: { ...assignmentRef, resourceId: 'assignment-2' },
        holder: {
          holder: {
            moduleId: 'core.identity' as const,
            resourceId: 'le-2',
            resourceType: 'core.identity.legal-entity' as const,
            tenantId,
          },
          holderKind: 'LEGAL_ENTITY' as const,
        },
        role: 'CONTROLLER' as const,
      },
    ];
    expect(
      assignments.map((assignment) => Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)(assignment)),
    ).toHaveLength(2);
  });

  it('requires provenance and an actor for every role assignment', () => {
    expect(() =>
      Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)({
        assignmentRef,
        effectiveFrom: '2026-09-14T10:00:00Z',
        effectiveTo: null,
        holder: { holder: principal, holderKind: 'PRINCIPAL' },
        role: 'PROCESSOR',
        scopeRef: { scopeId: 'scope-1', scopeType: 'privacy.processing-scope' },
      }),
    ).toThrow();
  });

  it('rejects Principal as a legal role holder even when assignment provenance is complete', () => {
    expect(() =>
      Schema.decodeUnknownSync(ResponsibilityRoleHolderSchema)({ holder: principal, holderKind: 'PRINCIPAL' }),
    ).toThrow();
  });

  it('rejects a Legal Entity holder from another tenant', () => {
    expect(() =>
      Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)({
        ...completeAssignment,
        holder: {
          holder: {
            moduleId: 'core.identity',
            resourceId: 'legal-entity-other-tenant',
            resourceType: 'core.identity.legal-entity',
            tenantId: '10000000-0000-4000-8000-000000000099',
          },
          holderKind: 'LEGAL_ENTITY',
        },
      }),
    ).toThrow();
  });

  it('rejects a Party holder from another tenant', () => {
    expect(() =>
      Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)({
        ...completeAssignment,
        holder: {
          holder: {
            moduleId: 'party.registry',
            resourceId: 'party-other-tenant',
            resourceType: 'party.registry.party',
            tenantId: '10000000-0000-4000-8000-000000000099',
          },
          holderKind: 'PARTY',
        },
      }),
    ).toThrow();
  });

  it('rejects an Action actor from another tenant', () => {
    expect(() =>
      Schema.decodeUnknownSync(PrivacyResponsibilityAssignmentSchema)({
        ...completeAssignment,
        actor: { ...principal, tenantId: '10000000-0000-4000-8000-000000000099' },
        holder: {
          holder: {
            moduleId: 'core.identity',
            resourceId: 'legal-entity-1',
            resourceType: 'core.identity.legal-entity',
            tenantId,
          },
          holderKind: 'LEGAL_ENTITY',
        },
      }),
    ).toThrow();
  });
});
