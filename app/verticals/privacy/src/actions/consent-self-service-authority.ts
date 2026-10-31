import type { DataAccessEventInput, OperationalScope } from '@app/core-runtime';
import { Context, Effect, Layer } from 'effect';

import { ConsentSelfServiceAuthorizationError } from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentSelfServiceAuthorityPorts } from '../../shared/domain/privacy-consent-self-service.ts';
import type { PrivacySubjectOwnerEvidence } from '../../shared/domain/privacy-subject.ts';
import type {
  PrivacyOperationPersistenceError,
  PrivacyOperationRepositoryService,
} from '../persistence/privacy-operation-repository.ts';
import type { ProcessingPurposeRepositoryService } from '../persistence/processing-purpose-repository.ts';
import type { PrivacyActionRejected } from './privacy-action-rejected.ts';

export interface ConsentSelfServiceAuthorityService {
  /** Explicit host assembly only; the Action supplies its actual scope and owner transaction. */
  readonly forScope?: (input: ConsentSelfServiceAuthorityScope) => ConsentSelfServiceAuthorityPorts;
  readonly ports: ConsentSelfServiceAuthorityPorts;
}

export interface ConsentSelfServiceAuthorityScope {
  readonly compositionRevision?: string;
  readonly observePartyEvidence?: (evidence: PrivacySubjectOwnerEvidence) => void;
  readonly scope: OperationalScope;
  readonly subjects: Pick<PrivacyOperationRepositoryService, 'listSubjects' | 'readCurrentConsent'>;
}

export class ConsentSelfServiceAuthority extends Context.Service<
  ConsentSelfServiceAuthority,
  ConsentSelfServiceAuthorityService
>()('@app/privacy/actions/consent-self-service-authority/ConsentSelfServiceAuthority') {}

export const consentSelfServiceAuthorityForScope = Effect.fn('ConsentSelfServiceAuthority.forScope')(function* forScope(
  input: ConsentSelfServiceAuthorityScope,
) {
  const authority = yield* ConsentSelfServiceAuthority;
  return { ports: authority.forScope?.(input) ?? authority.ports } satisfies ConsentSelfServiceAuthorityService;
});

/** No authority provider means no self-service mutation. */
export const consentSelfServiceAuthorityUnavailable = Object.freeze({
  ports: {
    resolveCurrentRetailPortalProfileBinding: () =>
      Effect.fail(
        new ConsentSelfServiceAuthorizationError({
          code: 'AUTHORITY_UNAVAILABLE',
          reason: 'Commerce consent authority is not configured',
        }),
      ),
    resolveSupportAuthority: () =>
      Effect.fail(
        new ConsentSelfServiceAuthorizationError({
          code: 'AUTHORITY_UNAVAILABLE',
          reason: 'Support consent authority is not configured',
        }),
      ),
    verifyOperationCredential: () =>
      Effect.fail(
        new ConsentSelfServiceAuthorizationError({
          code: 'AUTHORITY_UNAVAILABLE',
          reason: 'Operation consent authority is not configured',
        }),
      ),
  },
}) satisfies ConsentSelfServiceAuthorityService;

export const ConsentSelfServiceAuthorityUnavailableLive = Layer.succeed(
  ConsentSelfServiceAuthority,
  consentSelfServiceAuthorityUnavailable,
);

export interface ConsentSelfServiceServices {
  readonly accessEvidence?: readonly DataAccessEventInput[];
  readonly authority: ConsentSelfServiceAuthorityService;
  readonly consentDecision: Pick<ProcessingPurposeRepositoryService, 'get'> & {
    readonly recordConsentDecision: (
      ...args: Parameters<PrivacyOperationRepositoryService['recordConsentDecision']>
    ) => Effect.Effect<
      Effect.Success<ReturnType<PrivacyOperationRepositoryService['recordConsentDecision']>>,
      PrivacyActionRejected | PrivacyOperationPersistenceError
    >;
  };
}
