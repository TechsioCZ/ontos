import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AnonymousPrivacyContextSchema,
  DataSubjectSchema,
  PrincipalAttributionSchema,
  PrivacySubjectSchema,
  RepresentationSchema,
  RequesterSchema,
} from '../../shared/domain/privacy-subject.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const party = {
  moduleId: 'party.registry' as const,
  resourceId: 'party-1',
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const subjectRef = {
  moduleId: 'privacy.core' as const,
  resourceId: 'subject-1',
  resourceType: 'privacy.core.privacy-subject' as const,
  tenantId,
};

describe('privacy subject contracts', () => {
  it('keeps Party identity as the only identified data-subject reference', () => {
    expect(Schema.decodeUnknownSync(DataSubjectSchema)({ kind: 'DATA_SUBJECT', partyRef: party })).toEqual({
      kind: 'DATA_SUBJECT',
      partyRef: party,
    });
  });

  it('models anonymous context without Principal or Party identity', () => {
    const context = {
      addressability: 'COOKIE',
      contextRef: 'cookie:abc',
      createdAt: '2026-09-14T10:00:00Z',
      expiresAt: '2026-10-14T10:00:00Z',
      kind: 'ANONYMOUS_PRIVACY_CONTEXT',
      provenance: { method: 'browser-generated', source: 'privacy-choice' },
    } as const;
    const decoded = Schema.decodeUnknownSync(AnonymousPrivacyContextSchema)(context);
    expect(decoded.contextRef).toBe(context.contextRef);
    expect(decoded.createdAt).toBe('2026-09-14T10:00:00Z');
    const subject = Schema.decodeUnknownSync(PrivacySubjectSchema)({ anonymousContext: context, kind: 'ANONYMOUS' });
    expect(subject.kind).toBe('ANONYMOUS');
  });

  it('keeps a shared device unresolved and does not merge people behind one device', () => {
    const deviceContext = {
      addressability: 'DEVICE_BOUND',
      contextRef: 'device:shared-tablet-1',
      createdAt: '2026-09-14T10:00:00Z',
      expiresAt: '2026-09-14T18:00:00Z',
      kind: 'ANONYMOUS_PRIVACY_CONTEXT',
      provenance: { method: 'device-cookie', source: 'checkout' },
    } as const;
    const first = Schema.decodeUnknownSync(PrivacySubjectSchema)({
      anonymousContext: deviceContext,
      kind: 'ANONYMOUS',
    });
    const second = Schema.decodeUnknownSync(PrivacySubjectSchema)({
      anonymousContext: { ...deviceContext, provenance: { method: 'device-cookie', source: 'account-recovery' } },
      kind: 'ANONYMOUS',
    });
    expect(first).not.toEqual(second);
    if (first.kind === 'ANONYMOUS' && second.kind === 'ANONYMOUS') {
      expect(first.anonymousContext.contextRef).toBe(second.anonymousContext.contextRef);
    }
  });

  it('keeps B2B people as Party-backed subjects, separate from the legal entity', () => {
    const employee = Schema.decodeUnknownSync(DataSubjectSchema)({ kind: 'DATA_SUBJECT', partyRef: party });
    const legalEntity = {
      moduleId: 'core.identity' as const,
      resourceId: 'company-1',
      resourceType: 'core.identity.legal-entity' as const,
      tenantId,
    };
    expect(employee.partyRef.resourceType).toBe('party.registry.party');
    expect(() =>
      Schema.decodeUnknownSync(DataSubjectSchema)({ kind: 'DATA_SUBJECT', partyRef: legalEntity }),
    ).toThrow();
  });

  it('requires explicit representation scope and evidence', () => {
    const representation = {
      evidenceRefs: ['evidence:representation-1'],
      representativePrincipal: { principalId, tenantId },
      scope: { operation: 'DSR_EXPORT', rights: ['ACCESS'], subjectRef },
      validFrom: '2026-09-14T10:00:00Z',
      validTo: null,
    } as const;
    const decoded = Schema.decodeUnknownSync(RepresentationSchema)(representation);
    expect(decoded.scope.operation).toBe('DSR_EXPORT');
    expect(Option.isNone(decoded.validTo)).toBe(true);
    expect(() => Schema.decodeUnknownSync(RepresentationSchema)({ ...representation, evidenceRefs: [] })).toThrow();
  });

  it('does not turn a requester into a data subject or representation', () => {
    const requester = { kind: 'PRINCIPAL', principalRef: { principalId, tenantId } } as const;
    const attribution = {
      actor: { principalId, tenantId },
      attributedAt: '2026-09-14T10:00:00Z',
      authMethod: 'session',
      impersonatedBy: null,
    } as const;
    expect(Schema.decodeUnknownSync(RequesterSchema)(requester)).toEqual(requester);
    expect(Schema.decodeUnknownSync(PrincipalAttributionSchema)(attribution).authMethod).toBe('session');
  });
});
