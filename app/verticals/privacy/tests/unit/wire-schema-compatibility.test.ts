import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrivacySubjectRefSchema } from '../../shared/resources/privacy-subject.ts';
import { ConsentDecisionSchema } from '../../shared/domain/privacy-consent-decision.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const subjectRef = {
  moduleId: 'privacy.core',
  resourceId: 'subject:wire-proof',
  resourceType: 'privacy.core.privacy-subject',
  tenantId,
};

it.effect('keeps owner-issued resource identifiers as JSON strings', () =>
  Effect.gen(function* resourceWire() {
    const decoded = yield* Schema.decodeUnknownEffect(PrivacySubjectRefSchema)(subjectRef);
    expect(yield* Schema.encodeEffect(PrivacySubjectRefSchema)(decoded)).toEqual(subjectRef);
  }),
);

it.effect('retains explicit null and omitted optional consent evidence fields', () =>
  Effect.gen(function* consentWire() {
    const decision = {
      actorEvidence: null,
      decision: 'GRANTED',
      decisionId: 'decision:wire-proof',
      effectiveAt: '2026-09-14T10:00:00Z',
      flowEvidenceRefs: ['flow:wire-proof'],
      noticeEvidenceRefs: ['notice:wire-proof'],
      provenanceRefs: ['provenance:wire-proof'],
      recordedAt: '2026-09-14T10:00:00Z',
      scope: {
        controllerRef: 'controller:wire-proof',
        materialDimensions: [],
        privacySubjectRef: subjectRef,
        processingPurposeRef: {
          ...subjectRef,
          resourceId: 'purpose:wire-proof',
          resourceType: 'privacy.core.processing-purpose',
        },
        purposeMeaning: 'Wire compatibility proof',
        purposeVersionRef: 'purpose-version:1',
        scopeRef: 'scope:wire-proof',
      },
    };
    const decoded = yield* Schema.decodeUnknownEffect(ConsentDecisionSchema)(decision);
    expect(yield* Schema.encodeEffect(ConsentDecisionSchema)(decoded)).toEqual(decision);
  }),
);

it.effect('validates UTC wire timestamps without normalizing their spelling', () =>
  Effect.gen(function* timestampWire() {
    for (const wire of ['2026-09-14T10:00:00Z', '2026-09-14T10:00:00.000Z', '2026-09-14T10:00:00.123456Z']) {
      const decoded = yield* Schema.decodeUnknownEffect(PrivacyIsoTimestampSchema)(wire);
      expect(yield* Schema.encodeEffect(PrivacyIsoTimestampSchema)(decoded)).toBe(wire);
    }
    const invalid = yield* Effect.result(Schema.decodeUnknownEffect(PrivacyIsoTimestampSchema)('not-a-timestamp'));
    expect(Result.isFailure(invalid)).toBe(true);
  }),
);
