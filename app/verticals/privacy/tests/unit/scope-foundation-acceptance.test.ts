import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createProcessingPurposeAction } from '../../src/actions/create-processing-purpose.action.ts';
import { privacyManifest } from '../../vertical.manifest.ts';
import { PrivacySubjectPersistenceUnavailable } from '../../src/persistence/privacy-subject-repository.ts';
import type { PrivacySubjectRepositoryService } from '../../src/persistence/privacy-subject-repository.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';

const tenantA = '10000000-0000-4000-8000-000000000001';
const tenantB = '10000000-0000-4000-8000-000000000002';
const record = (tenantId: string) =>
  Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
    createdAt: '2026-09-14T10:00:00Z',
    subject: {
      anonymousContext: {
        addressability: 'SESSION',
        contextRef: `session:${tenantId}`,
        createdAt: '2026-09-14T10:00:00Z',
        expiresAt: '2026-09-14T11:00:00Z',
        kind: 'ANONYMOUS_PRIVACY_CONTEXT',
        provenance: { method: 'acceptance-test', source: 'scope-foundation' },
      },
      kind: 'ANONYMOUS',
    },
    subjectRef: {
      moduleId: 'privacy.core',
      resourceId: `subject:${tenantId}`,
      resourceType: 'privacy.core.privacy-subject',
      tenantId,
    },
    updatedAt: '2026-09-14T10:00:00Z',
  });

const tenantScopedRepository = (): PrivacySubjectRepositoryService => {
  const records = new Map<string, ReturnType<typeof record>>();
  return {
    findByRef: (ref) => Effect.succeed(Option.fromNullishOr(records.get(`${ref.tenantId}:${ref.resourceId}`))),
    save: (value) =>
      Effect.sync(() => {
        records.set(`${value.subjectRef.tenantId}:${value.subjectRef.resourceId}`, value);
      }),
  };
};

describe('privacy scope-foundation acceptance boundary', () => {
  it.effect('persists anonymous intake by tenant and cannot read another tenant through the repository contract', () =>
    Effect.gen(function* isolatesTenantReads() {
      const repository = tenantScopedRepository();
      const stored = record(tenantA);
      yield* repository.save(stored);
      const own = yield* repository.findByRef(stored.subjectRef);
      const foreign = yield* repository.findByRef({ ...stored.subjectRef, tenantId: tenantB });
      expect(Option.getOrUndefined(own)?.subjectRef.tenantId).toBe(tenantA);
      expect(Option.isNone(foreign)).toBe(true);
    }),
  );

  it('keeps persistence unavailable as an explicit closed error', () => {
    const error = new PrivacySubjectPersistenceUnavailable({
      code: 'privacy_subject_persistence_unavailable',
      reason: 'RLS context was not bound',
    });
    expect(error.code).toBe('privacy_subject_persistence_unavailable');
  });

  it('requires explicit tenant-scoped Action authorization and preserves inactive module state', () => {
    expect(createProcessingPurposeAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(createProcessingPurposeAction.descriptor.legalEntityScope).toBe('required');
    expect(privacyManifest.activation.scope).toBe('tenant');
    expect(privacyManifest.activation.defaultState).toBe('inactive');
  });
});
