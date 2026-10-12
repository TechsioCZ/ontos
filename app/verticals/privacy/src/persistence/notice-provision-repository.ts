import type { Effect, Option } from 'effect';
import { Context, Effect as EffectValue, Option as OptionValue, Schema } from 'effect';

import { PrivacyNoticeProvisionSchema } from '../../shared/domain/privacy-notice-provision.ts';
import type { PrivacyNoticeProvision } from '../../shared/domain/privacy-notice-provision.ts';
import { NoticeProvisionPersistenceError } from './notice-provision-persistence-error.ts';

export { NoticeProvisionPersistenceError } from './notice-provision-persistence-error.ts';

export interface NoticeProvisionRepositoryService {
  readonly findById: (
    tenantId: string,
    legalEntityId: string,
    provisionId: string,
  ) => Effect.Effect<Option.Option<PrivacyNoticeProvision>, NoticeProvisionPersistenceError>;
  readonly listForSubject: (
    tenantId: string,
    legalEntityId: string,
    privacySubjectRef: string,
  ) => Effect.Effect<readonly PrivacyNoticeProvision[], NoticeProvisionPersistenceError>;
  readonly record: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    provision: PrivacyNoticeProvision,
  ) => Effect.Effect<PrivacyNoticeProvision, NoticeProvisionPersistenceError>;
}

/** Owner-local service contract; scope is supplied by its transaction factory. */
export class NoticeProvisionRepository extends Context.Service<
  NoticeProvisionRepository,
  NoticeProvisionRepositoryService
>()('@app/privacy/persistence/notice-provision-repository/NoticeProvisionRepository') {}

const provisionsAreEquivalent = Schema.toEquivalence(PrivacyNoticeProvisionSchema);
const noticeProvisionScopedKey = (tenantId: string, legalEntityId: string, value: string): string =>
  `${tenantId}:${legalEntityId}:${value}`;
const noticeProvisionConflict = (reason: string) =>
  new NoticeProvisionPersistenceError({ code: 'privacy_notice_provision_identity_conflict', reason });

export const makeInMemoryNoticeProvisionRepository = (): NoticeProvisionRepositoryService => {
  const records = new Map<string, PrivacyNoticeProvision>();
  const invocationRecords = new Map<string, PrivacyNoticeProvision>();

  return {
    findById: (tenantId, legalEntityId, provisionId) =>
      EffectValue.succeed(
        OptionValue.fromNullishOr(records.get(noticeProvisionScopedKey(tenantId, legalEntityId, provisionId))),
      ),
    listForSubject: (tenantId, legalEntityId, privacySubjectRef) => {
      const provisions: PrivacyNoticeProvision[] = [];
      for (const [key, provision] of records) {
        if (key.startsWith(`${tenantId}:${legalEntityId}:`) && provision.privacySubjectRef === privacySubjectRef) {
          provisions.push(provision);
        }
      }
      return EffectValue.succeed(provisions);
    },
    record: EffectValue.fn('makeInMemoryNoticeProvisionRepository.record')(
      function* record(tenantId, legalEntityId, actionInvocationId, provision) {
        const invocationKey = noticeProvisionScopedKey(tenantId, legalEntityId, actionInvocationId);
        const replay = invocationRecords.get(invocationKey);
        if (replay !== undefined) {
          return provisionsAreEquivalent(replay, provision)
            ? replay
            : yield* noticeProvisionConflict('Action invocation was replayed with a different Notice Provision');
        }
        const recordKey = noticeProvisionScopedKey(tenantId, legalEntityId, provision.provisionId);
        const existing = records.get(recordKey);
        if (existing !== undefined && !provisionsAreEquivalent(existing, provision)) {
          return yield* noticeProvisionConflict('Notice Provision identity already belongs to different evidence');
        }
        const retained = existing ?? Object.freeze({ ...provision });
        records.set(recordKey, retained);
        invocationRecords.set(invocationKey, retained);
        return retained;
      },
    ),
  };
};
