import type { Effect, Option } from 'effect';
import { Context, Schema } from 'effect';

import type {
  SourceProcessingAuthorization,
  SourceProcessingRoute,
} from '../../shared/domain/privacy-source-processing-authorization.ts';
import { PrivacyIsoTimestampSchema } from '../../shared/domain/privacy-subject.ts';
import type { PrivacySourceRecordIdentity } from '../../shared/domain/privacy-subject.ts';
import type { PrivacyOperationPersistenceError } from './privacy-operation-persistence-error.ts';

/** A SUBJECT record is the subject's own source; a CHILD record (contact, address) describes that subject. */
export const SourceProcessingAdmissionRoleSchema = Schema.Literals(['SUBJECT', 'CHILD']);
export type SourceProcessingAdmissionRole = typeof SourceProcessingAdmissionRoleSchema.Type;

export const SourceProcessingAdmissionRowSchema = Schema.Struct({
  firstAdmittedAt: PrivacyIsoTimestampSchema,
  lastAdmittedAt: PrivacyIsoTimestampSchema,
  role: SourceProcessingAdmissionRoleSchema,
  subjectId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('PrivacySourceAdmittedSubjectId'),
    Schema.decodeTo(Schema.String),
  ),
});
export type SourceProcessingAdmissionRow = typeof SourceProcessingAdmissionRowSchema.Type;

interface SourceProcessingAdmittedSource {
  readonly role: SourceProcessingAdmissionRole;
  readonly source: PrivacySourceRecordIdentity;
}

/** Owner-local, transaction-scoped access to standing source authorizations and the subjects they admitted. */
export interface SourceProcessingAuthorizationRepositoryService {
  /** Every ACTIVE authorization of the route; the active-route key keeps it to at most one. */
  readonly activeForRoute: (
    route: Pick<SourceProcessingRoute, 'issuer' | 'namespace' | 'routeRef'>,
    lock?: 'admission',
  ) => Effect.Effect<readonly SourceProcessingAuthorization[], PrivacyOperationPersistenceError>;
  /** The subject a source record resolves to across grant incarnations. */
  readonly admission: (
    source: PrivacySourceRecordIdentity,
  ) => Effect.Effect<Option.Option<SourceProcessingAdmissionRow>, PrivacyOperationPersistenceError>;
  /** Records the sources of one subject, or refreshes when the route last used them. */
  readonly admit: (input: {
    readonly actionInvocationId: string;
    readonly admittedAt: string;
    readonly authorizationId: string;
    /** Only set when Commerce has identified the existing customer source of this membership. */
    readonly membershipRoot?: PrivacySourceRecordIdentity;
    readonly sources: readonly SourceProcessingAdmittedSource[];
    readonly subjectId: string;
  }) => Effect.Effect<SourceProcessingAdmissionRow, PrivacyOperationPersistenceError>;
  readonly create: (
    authorization: SourceProcessingAuthorization,
    actionInvocationId: string,
  ) => Effect.Effect<SourceProcessingAuthorization, PrivacyOperationPersistenceError>;
  /** Ends an ACTIVE authorization at its expected revision. */
  readonly end: (
    ended: SourceProcessingAuthorization,
    expectedRevision: number,
    actionInvocationId: string,
  ) => Effect.Effect<SourceProcessingAuthorization, PrivacyOperationPersistenceError>;
  readonly get: (
    authorizationId: string,
  ) => Effect.Effect<Option.Option<SourceProcessingAuthorization>, PrivacyOperationPersistenceError>;
  /** Includes an ended route so its old contexts can never authorize new uses. */
  readonly historyForRoute: SourceProcessingAuthorizationRepositoryService['activeForRoute'];
  readonly sourceSubjectId: (
    source: PrivacySourceRecordIdentity,
  ) => Effect.Effect<Option.Option<string>, PrivacyOperationPersistenceError>;
}

export class SourceProcessingAuthorizationRepository extends Context.Service<
  SourceProcessingAuthorizationRepository,
  SourceProcessingAuthorizationRepositoryService
>()('@app/privacy/persistence/source-processing-authorization-repository/SourceProcessingAuthorizationRepository') {}
