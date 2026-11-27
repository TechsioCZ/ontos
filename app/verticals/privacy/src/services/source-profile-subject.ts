import type { OperationalScope } from '@app/core-runtime';
import { requireModuleOperation } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  readVerifiedGatewayRecovery,
  readVerifiedGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { executeSourceProfileSubjectWithAuthorization } from '@app/commerce-customer-context/api/source-profile-subject/client';
import {
  SourceProfileSubjectRequestSchema,
  SourceProfileSubjectResponseSchema,
} from '@app/commerce-customer-context/api/source-profile-subject';
import { Effect, Option, Schema } from 'effect';
import type { Crypto } from 'effect';

import { privacySourceSubjectIdentityKey } from '../../shared/domain/privacy-subject.ts';
import type { PrivacySourceRecordIdentity } from '../../shared/domain/privacy-subject.ts';

const ProfileTargetSchema = Schema.Struct({
  kind: Schema.Literals(['RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY_PURCHASING_PROFILE']),
  resourceId: Schema.toEncoded(Schema.String.pipe(Schema.brand('PrivacySourceTargetId'))),
});
export type ProfileTarget = typeof ProfileTargetSchema.Type;
export const isProfileTarget = Schema.is(ProfileTargetSchema);
/**
 * Commerce's proof of who owns a profile. With the person's own source record it proves that exact binding, so another
 * record of the same person on the profile changes nothing; without one it returns the profile's canonical owner binding.
 */
export const readProfileSubject = Effect.fn('Privacy.readProfileSubject')(function* readProfileSubject(
  scope: OperationalScope,
  target: ProfileTarget,
  requirement:
    | 'privacy.core.requirement.source-processing-profile-subject'
    | 'privacy.core.requirement.admit-profile-subject',
  crypto: Crypto.Crypto,
  personRecord?: PrivacySourceRecordIdentity,
) {
  yield* requireModuleOperation(requirement);
  const retail = target.kind === 'RETAIL_CUSTOMER_PROFILE';
  const profileRef = {
    kind: retail ? 'RETAIL' : 'COUNTERPARTY',
    moduleId: 'commerce.customer-context',
    resourceId: target.resourceId,
    resourceType: retail
      ? 'commerce.customer-context.retail-customer-profile'
      : 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId: scope.tenantId,
  };
  const request = yield* Schema.decodeUnknownEffect(SourceProfileSubjectRequestSchema)(
    personRecord === undefined
      ? { profileRef }
      : {
          personRecord: {
            recordId: personRecord.recordId,
            source: {
              issuer: personRecord.issuer,
              namespace: personRecord.namespace,
              recordType: personRecord.recordType,
              routeRef: personRecord.routeRef,
            },
          },
          profileRef,
        },
  );
  const recovery = readVerifiedGatewayRecovery(scope);
  const registered = {
    _tag: 'RegisteredAssertion' as const,
    declarationKey: 'commerce.customer-context.source-profile-subject.read',
    expectedPrincipalId: scope.principalId,
    operationRequirementKey: requirement,
    scope,
  };
  if (recovery !== undefined) {
    Object.assign(registered, { recoveryRequestHash: computeCanonicalValueHash(request) });
  }
  const gateway = yield* acquireDelegatedGatewayContext(
    {
      audience: 'commerce-customer-context',
      legalEntityScope: 'subject',
      requestCorrelation: scope.correlationId,
      subject:
        scope.authMethod === 'system' || readVerifiedGatewayWorkload(scope) !== undefined || recovery !== undefined
          ? registered
          : { _tag: 'Assertion', scope },
    },
    crypto,
  );
  const result = yield* executeSourceProfileSubjectWithAuthorization(
    request,
    gateway.authorization,
    scope.correlationId,
    { baseUrl: gateway.apiBaseUrl, compositionRevision: gateway.compositionRevision },
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SourceProfileSubjectResponseSchema)));
  return Schema.is(SourceProfileSubjectResponseSchema.members[1])(result) &&
    Schema.toEquivalence(SourceProfileSubjectRequestSchema.fields.profileRef)(result.profileRef, request.profileRef) &&
    result.legalEntityId === scope.legalEntityId &&
    result.partyRef.tenantId === scope.tenantId &&
    (personRecord === undefined ||
      privacySourceSubjectIdentityKey({
        ...result.sourceReference.source,
        recordId: result.sourceReference.recordId,
      }) === privacySourceSubjectIdentityKey(personRecord))
    ? Option.some(result)
    : Option.none();
});
