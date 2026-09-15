import type { Effect, Option } from 'effect';
import { Schema } from 'effect';

import type { PrivacySubjectRecord } from '../../shared/domain/privacy-subject.ts';
import type { PrivacySubjectRef } from '../../shared/resources/privacy-subject.ts';

const persistenceUnavailableFields = {
  code: Schema.Literal('privacy_subject_persistence_unavailable'),
  reason: Schema.String,
} as const;
export const PrivacySubjectPersistenceUnavailable = Schema.TaggedError<typeof persistenceUnavailableFields>()(
  'PrivacySubjectPersistenceUnavailable',
  persistenceUnavailableFields,
);
type PrivacySubjectPersistenceUnavailableError = InstanceType<typeof PrivacySubjectPersistenceUnavailable>;

/** Owner-local persistence seam. Implementations must bind tenant/RLS context before access. */
// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- Acceptance adapters inject this owner-local repository explicitly; it has no global Context lifetime. expires: 2027-03-31.
export interface PrivacySubjectRepositoryService {
  readonly findByRef: (
    ref: PrivacySubjectRef,
  ) => Effect.Effect<Option.Option<PrivacySubjectRecord>, PrivacySubjectPersistenceUnavailableError>;
  readonly save: (record: PrivacySubjectRecord) => Effect.Effect<void, PrivacySubjectPersistenceUnavailableError>;
}
