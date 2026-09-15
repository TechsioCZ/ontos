import { describe, expect, it } from 'effect-rstest';
import { Effect, Option } from 'effect';

import { makeInMemoryPrivacyNoticeVersionCatalog } from '../../src/domain/privacy-notice-version-catalog.ts';
import { InvalidPrivacyNoticeContent } from '../../shared/domain/privacy-notice-version.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const scope = {
  facts: [{ dimension: 'CONTROLLER_SCOPE' as const, value: 'controller-1' }],
  operation: 'account-creation',
  processingScopeRef: { scopeId: 'scope-1', scopeType: 'privacy.processing-scope' as const },
};

const input = {
  applicableScope: scope,
  contentIdentity: 'sha256:notice-v1',
  evidenceArtifactRef: null,
  language: 'cs-CZ',
  wording: 'Informace o zpracování osobních údajů.',
};

describe('Privacy Notice Version catalog', () => {
  it.effect('creates an addressable immutable version with exact content identity and scope', () =>
    Effect.gen(function* createsNoticeVersion() {
      const catalog = makeInMemoryPrivacyNoticeVersionCatalog();
      const version = yield* catalog.create(tenantId, input);
      expect(version.versionNumber).toBe(1);
      expect(version.language).toBe('cs-CZ');
      expect(version.contentIdentity).toBe('sha256:notice-v1');
      expect(version.applicableScope).toEqual(scope);
    }),
  );

  it.effect('keeps V1 historical after creating an independent V2 artifact-backed version', () =>
    Effect.gen(function* preservesHistoricalVersion() {
      const catalog = makeInMemoryPrivacyNoticeVersionCatalog();
      const first = yield* catalog.create(tenantId, input);
      const second = yield* catalog.addVersion(first.noticeRef.resourceId, {
        ...input,
        contentIdentity: 'sha256:notice-v2',
        evidenceArtifactRef: 'artifact://notice-v2',
        wording: null,
      });
      const historical = yield* catalog.get(first.noticeRef.resourceId, 1);
      expect(second.versionNumber).toBe(2);
      expect(Option.isSome(historical)).toBe(true);
      if (Option.isSome(historical)) {
        expect(historical.value.contentIdentity).toBe('sha256:notice-v1');
        expect(historical.value.wording).toBe(input.wording);
        expect(historical.value.evidenceArtifactRef).toBeNull();
      }
    }),
  );

  it.effect('rejects a version with neither historical wording nor an artifact reference', () =>
    Effect.gen(function* rejectsMissingContent() {
      const catalog = makeInMemoryPrivacyNoticeVersionCatalog();
      const error = yield* Effect.flip(catalog.create(tenantId, { ...input, wording: null }));
      expect(error).toBeInstanceOf(InvalidPrivacyNoticeContent);
    }),
  );
});
