import { NodeCrypto } from '@effect/platform-node';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';

import { makeInMemoryPrivacyNoticeVersionCatalog } from '../../src/domain/privacy-notice-version-catalog.ts';
import {
  comparePrivacyNoticeInstants,
  CreatePrivacyNoticeVersionInputSchema,
  InvalidPrivacyNoticeContent,
} from '../../shared/domain/privacy-notice-version.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';
import { NoticeVersionsRequestSchema } from '../../shared/privacy-queries.ts';

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
  it('rejects malformed calendar instants at Notice Create input without relying on an end or previous version', () => {
    for (const invalid of [
      '2026-02-30T10:00:00Z',
      '2026-02-29T10:00:00Z',
      '2026-04-31T10:00:00Z',
      '2026-10-17T24:00:00Z',
    ]) {
      expect(Schema.is(CreatePrivacyNoticeVersionInputSchema)({ ...input, effectiveFrom: invalid })).toBe(false);
      expect(Schema.is(CreatePrivacyNoticeVersionInputSchema)({ ...input, effectiveTo: invalid })).toBe(false);
    }
  });

  it('rejects malformed calendar instants at the actual Notice Read request schema', () => {
    for (const asOf of [
      '2026-02-30T10:00:00Z',
      '2026-02-29T10:00:00Z',
      '2026-04-31T10:00:00Z',
      '2026-10-17T24:00:00Z',
    ]) {
      expect(Schema.is(NoticeVersionsRequestSchema)({ asOf, languages: [], noticeRefs: [] })).toBe(false);
    }
  });

  it('roundtrips valid leap-day and arbitrary fractional Notice inputs and Read requests unchanged', () => {
    for (const wire of [
      '2024-02-29T23:59:59Z',
      '2024-02-29T23:59:59.000Z',
      '2024-02-29T23:59:59.123456789012345000Z',
    ]) {
      const create = { ...input, effectiveFrom: wire };
      expect(
        Schema.encodeSync(CreatePrivacyNoticeVersionInputSchema)(
          Schema.decodeUnknownSync(CreatePrivacyNoticeVersionInputSchema)(create),
        ),
      ).toEqual(create);
      const read = { asOf: wire, languages: [], noticeRefs: [] };
      expect(
        Schema.encodeSync(NoticeVersionsRequestSchema)(Schema.decodeUnknownSync(NoticeVersionsRequestSchema)(read)),
      ).toEqual(read);
    }
  });

  it('compares equivalent UTC spellings without changing their accepted wire precision', () => {
    for (const [left, right] of [
      ['2026-10-17T10:00:00Z', '2026-10-17T10:00:00.000Z'],
      ['2026-10-17T10:00:00.1Z', '2026-10-17T10:00:00.100000Z'],
      ['2026-10-17T10:00:00.123456Z', '2026-10-17T10:00:00.123456000Z'],
      ['2024-02-29T23:59:59.123456789012345Z', '2024-02-29T23:59:59.123456789012345000Z'],
    ]) {
      expect(comparePrivacyNoticeInstants(left, right)).toBe(0);
      expect(comparePrivacyNoticeInstants(right, left)).toBe(0);
      for (const wire of [left, right]) {
        const decoded = Schema.decodeUnknownSync(PrivacyIsoTimestampSchema)(wire);
        expect(Schema.encodeSync(PrivacyIsoTimestampSchema)(decoded)).toBe(wire);
      }
    }
  });

  it('preserves ordering below milliseconds and at arbitrary accepted fractional precision', () => {
    for (const [earlier, later] of [
      ['2026-10-17T10:00:00Z', '2026-10-17T10:00:00.000001Z'],
      ['2026-10-17T10:00:00.123456Z', '2026-10-17T10:00:00.123457Z'],
      ['2026-10-17T10:00:00.123456789012345Z', '2026-10-17T10:00:00.123456789012346Z'],
      ['2026-10-17T10:00:00.999999Z', '2026-10-17T10:00:01Z'],
      ['2026-10-17T09:59:59.999999Z', '2026-10-17T10:00:00Z'],
    ]) {
      expect(comparePrivacyNoticeInstants(earlier, later)).toBeLessThan(0);
      expect(comparePrivacyNoticeInstants(later, earlier)).toBeGreaterThan(0);
    }
  });

  it('never orders malformed or unsupported timestamps', () => {
    const valid = '2026-10-17T10:00:00Z';
    for (const invalid of [
      'not-a-timestamp',
      '2026-10-17',
      '2026-10-17T10:00:00+00:00',
      '2026-02-30T10:00:00Z',
      '2026-02-29T10:00:00Z',
      '2026-04-31T10:00:00Z',
      '2026-10-17T24:00:00Z',
    ]) {
      expect(comparePrivacyNoticeInstants(invalid, valid)).toBeUndefined();
      expect(comparePrivacyNoticeInstants(valid, invalid)).toBeUndefined();
    }
  });

  it.effect('creates an addressable immutable version with exact content identity and scope', () =>
    Effect.gen(function* createsNoticeVersion() {
      const catalog = yield* makeInMemoryPrivacyNoticeVersionCatalog();
      const version = yield* catalog.create(tenantId, input);
      expect(version.versionNumber).toBe(1);
      expect(version.language).toBe('cs-CZ');
      expect(version.contentIdentity).toBe('sha256:notice-v1');
      expect(version.applicableScope).toEqual(scope);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('keeps V1 historical after creating an independent V2 artifact-backed version', () =>
    Effect.gen(function* preservesHistoricalVersion() {
      const catalog = yield* makeInMemoryPrivacyNoticeVersionCatalog();
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
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects a version with neither historical wording nor an artifact reference', () =>
    Effect.gen(function* rejectsMissingContent() {
      const catalog = yield* makeInMemoryPrivacyNoticeVersionCatalog();
      const error = yield* Effect.flip(catalog.create(tenantId, { ...input, wording: null }));
      expect(error).toBeInstanceOf(InvalidPrivacyNoticeContent);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
