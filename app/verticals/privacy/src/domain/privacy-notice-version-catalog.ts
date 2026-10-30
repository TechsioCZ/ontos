import { Crypto, DateTime, Effect, Option } from 'effect';

import {
  InvalidPrivacyNoticeContent,
  PrivacyNoticeVersionNotFound,
} from '../../shared/domain/privacy-notice-version.ts';
import type {
  CreatePrivacyNoticeVersionInput,
  PrivacyNoticeVersion,
} from '../../shared/domain/privacy-notice-version.ts';
import type { PrivacyNoticeVersionRef } from '../../shared/resources/privacy-notice-version.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-persistence-error.ts';

export interface PrivacyNoticeVersionCatalog {
  addVersion: (
    noticeId: string,
    input: CreatePrivacyNoticeVersionInput,
  ) => Effect.Effect<
    PrivacyNoticeVersion,
    InvalidPrivacyNoticeContent | PrivacyNoticeVersionNotFound | PrivacyOperationPersistenceError
  >;
  create: (
    tenantId: string,
    input: CreatePrivacyNoticeVersionInput,
  ) => Effect.Effect<PrivacyNoticeVersion, InvalidPrivacyNoticeContent | PrivacyOperationPersistenceError>;
  get: (noticeId: string, versionNumber?: number) => Effect.Effect<Option.Option<PrivacyNoticeVersion>>;
}

const ref = (tenantId: string, noticeId: string): PrivacyNoticeVersionRef => ({
  moduleId: 'privacy.core',
  resourceId: noticeId,
  resourceType: 'privacy.core.privacy-notice-version',
  tenantId,
});

const validateContent = (
  input: CreatePrivacyNoticeVersionInput,
): Effect.Effect<CreatePrivacyNoticeVersionInput, InvalidPrivacyNoticeContent> => {
  if (input.wording === null && input.evidenceArtifactRef === null) {
    return Effect.fail(
      new InvalidPrivacyNoticeContent({
        code: 'privacy_notice_content_invalid',
        reason: 'A notice version requires wording or an evidence artifact reference',
      }),
    );
  }
  return Effect.succeed(input);
};

const makeCatalog = (crypto: Crypto.Crypto): PrivacyNoticeVersionCatalog => {
  const notices = new Map<string, PrivacyNoticeVersion[]>();
  const nextIdentifier = (reason: string) =>
    crypto
      .randomUUIDv4()
      .pipe(
        Effect.catchTag('PlatformError', () =>
          Effect.fail(
            new PrivacyOperationPersistenceError({ code: 'privacy_operation_persistence_unavailable', reason }),
          ),
        ),
      );
  const createVersion = (options: {
    readonly input: CreatePrivacyNoticeVersionInput;
    readonly noticeId: string;
    readonly recordedAt: string;
    readonly tenantId: string;
    readonly versionId: string;
    readonly versionNumber: number;
  }): PrivacyNoticeVersion => ({
    applicableScope: options.input.applicableScope,
    contentIdentity: options.input.contentIdentity,
    effectiveFrom: options.input.effectiveFrom ?? options.recordedAt,
    effectiveTo: options.input.effectiveTo ?? null,
    evidenceArtifactRef: options.input.evidenceArtifactRef,
    language: options.input.language,
    noticeRef: ref(options.tenantId, options.noticeId),
    recordedAt: options.recordedAt,
    versionId: options.versionId,
    versionNumber: options.versionNumber,
    wording: options.input.wording,
  });
  return {
    addVersion: Effect.fn('makeInMemoryPrivacyNoticeVersionCatalog.addVersion')(function* addVersion(noticeId, input) {
      const current = notices.get(noticeId);
      if (current === undefined) {
        return yield* new PrivacyNoticeVersionNotFound({
          code: 'privacy_notice_version_not_found',
          reason: 'Privacy Notice identity was not found',
        });
      }
      const first = current.at(0);
      if (first === undefined) {
        return yield* new PrivacyNoticeVersionNotFound({
          code: 'privacy_notice_version_not_found',
          reason: 'Privacy Notice identity has no retained version',
        });
      }
      const valid = yield* validateContent(input);
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const versionId = yield* nextIdentifier('Notice Version identifier could not be generated');
      const version = createVersion({
        input: valid,
        noticeId,
        recordedAt,
        tenantId: first.noticeRef.tenantId,
        versionId,
        versionNumber: current.length + 1,
      });
      notices.set(noticeId, [...current, version]);
      return version;
    }),
    create: Effect.fn('makeInMemoryPrivacyNoticeVersionCatalog.create')(function* create(tenantId, input) {
      const valid = yield* validateContent(input);
      const [noticeId, versionId] = yield* Effect.all(
        [
          nextIdentifier('Privacy Notice identifier could not be generated'),
          nextIdentifier('Notice Version identifier could not be generated'),
        ],
        { concurrency: 2 },
      );
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const version = createVersion({ input: valid, noticeId, recordedAt, tenantId, versionId, versionNumber: 1 });
      notices.set(noticeId, [version]);
      return version;
    }),
    get: (noticeId, versionNumber) =>
      Effect.sync(() => {
        const versions = notices.get(noticeId) ?? [];
        return Option.fromNullishOr(
          versionNumber === undefined
            ? versions.at(-1)
            : versions.find((version) => version.versionNumber === versionNumber),
        );
      }),
  };
};

export const makeInMemoryPrivacyNoticeVersionCatalog = (): Effect.Effect<
  PrivacyNoticeVersionCatalog,
  never,
  Crypto.Crypto
> => Effect.service(Crypto.Crypto).pipe(Effect.map(makeCatalog));
