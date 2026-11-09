import { PartyDetailResponseSchema, executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import type { OperationalScope } from '@app/core-runtime';
import { readVerifiedGatewayRecovery } from '@app/core-runtime/auth/system-principal-context-provenance';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { executeSourcePersonAdmissionWithAuthorization } from '@app/party-registry/apis/source-person-admission/client';
import {
  SourcePersonAdmissionRequestSchema,
  SourcePersonAdmissionResponseSchema,
} from '@app/party-registry/apis/source-person-admission';
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';

import type { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import { PrivacyPartyRefSchema as PartyRefSchema } from '../../shared/domain/party-reference.ts';
import { PrivacySubjectOwnerEvidenceSchema } from '../../shared/domain/privacy-subject.ts';
import type { PrivacySubjectOwnerEvidence, PrivacySourcePersonReference } from '../../shared/domain/privacy-subject.ts';
import { PrivacySubjectPartyCredentials } from './privacy-subject-party-credentials.ts';
import type { PrivacyPartyOwnerRequirement } from './privacy-subject-party-credentials.ts';
import { PrivacyOperationPersistenceError } from './privacy-operation-persistence-error.ts';

type PartyRef = typeof PrivacyPartyRefSchema.Type;

const unavailable = (cause?: unknown) => {
  const error = new PrivacyOperationPersistenceError({
    code: 'privacy_operation_persistence_unavailable',
    reason: 'Authoritative current PERSON Party evidence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: Redacted.make(cause) });
  }
  return error;
};

export { PrivacySubjectPartyCredentials } from './privacy-subject-party-credentials.ts';

export class PrivacySubjectPartyOwner extends Context.Service<
  PrivacySubjectPartyOwner,
  {
    readonly resolve: (
      partyRef: PartyRef,
      scope: OperationalScope,
      canonicalWrite: boolean,
      sourceReference?: PrivacySourcePersonReference,
      operationRequirementKey?: PrivacyPartyOwnerRequirement,
    ) => Effect.Effect<PrivacySubjectOwnerEvidence, PrivacyOperationPersistenceError>;
  }
>()('@app/privacy/persistence/privacy-subject-party-owner/PrivacySubjectPartyOwner') {}

export const privacySubjectPartyOwnerUnavailable = PrivacySubjectPartyOwner.of({
  resolve: () => Effect.fail(unavailable()),
});

const sameRef = Schema.toEquivalence(Schema.toEncoded(PartyRefSchema));
const currentPersonTypeAssertions = (
  assertions: (typeof PartyDetailResponseSchema.Type)['currentFactAssertions'],
  canonical: typeof PartyRefSchema.Encoded,
  millis: number,
): boolean =>
  assertions.length > 0 &&
  !assertions.some(
    (assertion) =>
      !sameRef(assertion.partyRef, canonical) ||
      assertion.value !== 'PERSON' ||
      assertion.state !== 'ACTIVE' ||
      !assertion.isCurrent ||
      DateTime.toEpochMillis(assertion.validFrom) > millis ||
      Option.exists(assertion.validTo, (end) => DateTime.toEpochMillis(end) <= millis),
  );

const partyOwnerDeclaration = (sourceReference: PrivacySourcePersonReference | undefined) =>
  sourceReference === undefined
    ? ('party.registry.party.read' as const)
    : ('party.registry.source-person-admission.read' as const);

interface PartyOwnerTransport {
  readonly authorization: Redacted.Redacted;
  readonly baseUrl: string;
  readonly compositionRevision: string;
}
/** Interprets only an actual freshly fetched public owner proof. Production callers obtain it
 * directly; INTERNAL fixture setup may consume the same live proof projected by the CCC owner. */
export const admitCurrentSourcePersonProof = Effect.fn('PrivacySubjectPartyOwner.admitCurrentSourcePersonProof')(
  function* admit(partyRef: PartyRef, tenantId: string, result: typeof SourcePersonAdmissionResponseSchema.Type) {
    if (result.outcome === 'NOT_ADMISSIBLE') {
      return yield* new PrivacyOperationPersistenceError({
        code: 'privacy_operation_conflict',
        reason: 'Party rejected the exact source-person admission correlation',
      });
    }
    if (
      result.outcome !== 'SOURCE_PERSON_CURRENT' ||
      !Schema.toEquivalence(Schema.toEncoded(PartyRefSchema))(result.partyRef, partyRef) ||
      result.sourceDecisionRef.tenantId !== tenantId
    ) {
      return yield* unavailable();
    }
    const evidence = yield* Schema.decodeUnknownEffect(PrivacySubjectOwnerEvidenceSchema)({
      observedAt: DateTime.formatIso(yield* DateTime.now),
      ownerRevision: result.partyRevision,
      partyRef,
      sourcePersonAdmission: {
        sourceActionInvocationId: result.sourceActionInvocationId,
        sourceDecisionRef: result.sourceDecisionRef,
      },
      typeAssertions: [],
    }).pipe(Effect.mapError(unavailable));
    return { evidence, proof: result };
  },
);
export const resolveSourcePersonOwnerProof = Effect.fn('PrivacySubjectPartyOwner.sourcePersonEvidence')(
  function* sourcePerson(
    partyRef: PartyRef,
    scope: Pick<OperationalScope, 'correlationId' | 'tenantId'>,
    sourceReference: PrivacySourcePersonReference,
    transport: PartyOwnerTransport,
  ) {
    const result = yield* executeSourcePersonAdmissionWithAuthorization(
      { partyRef, sourceReference },
      Redacted.value(transport.authorization),
      scope.correlationId,
      { baseUrl: transport.baseUrl, compositionRevision: transport.compositionRevision },
    ).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(SourcePersonAdmissionResponseSchema)(value).pipe(Effect.mapError(unavailable)),
      ),
    );
    return yield* admitCurrentSourcePersonProof(partyRef, scope.tenantId, result);
  },
);
export const resolveSourcePersonOwnerEvidence = (
  partyRef: PartyRef,
  scope: Pick<OperationalScope, 'correlationId' | 'tenantId'>,
  sourceReference: PrivacySourcePersonReference,
  transport: PartyOwnerTransport,
) =>
  resolveSourcePersonOwnerProof(partyRef, scope, sourceReference, transport).pipe(
    Effect.map(({ evidence }) => evidence),
  );

/** Uses the published generated owner client; ordinary detail requires no privileged fact history. */
export const PrivacySubjectPartyOwnerLive = Layer.effect(
  PrivacySubjectPartyOwner,
  Effect.gen(function* partyOwnerClient() {
    const credentials = yield* PrivacySubjectPartyCredentials;
    const sourceEvidence = Effect.fn('PrivacySubjectPartyOwner.currentSourceEvidence')(function* evidence(
      partyRef: PartyRef,
      scope: OperationalScope,
      sourceReference: PrivacySourcePersonReference,
      operationRequirementKey: PrivacyPartyOwnerRequirement | undefined,
    ) {
      const sourceRequest = yield* Schema.decodeUnknownEffect(SourcePersonAdmissionRequestSchema, {
        onExcessProperty: 'error',
      })({ partyRef, sourceReference }).pipe(Effect.mapError(unavailable));
      const requestHash =
        readVerifiedGatewayRecovery(scope) === undefined ? undefined : computeCanonicalValueHash(sourceRequest);
      const transport = yield* credentials.acquire(
        scope,
        partyOwnerDeclaration(sourceReference),
        operationRequirementKey,
        requestHash,
      );
      return yield* resolveSourcePersonOwnerEvidence(partyRef, scope, sourceRequest.sourceReference, transport);
    });
    return PrivacySubjectPartyOwner.of({
      resolve: Effect.fn('PrivacySubjectPartyOwner.resolve')(
        function* resolvePartyOwner(partyRef, scope, canonicalWrite, sourceReference, operationRequirementKey) {
          if (partyRef.tenantId !== scope.tenantId) {
            return yield* unavailable();
          }
          if (sourceReference !== undefined) {
            return yield* sourceEvidence(partyRef, scope, sourceReference, operationRequirementKey);
          }
          const transport = yield* credentials.acquire(
            scope,
            partyOwnerDeclaration(sourceReference),
            operationRequirementKey,
          );
          const detail = yield* executePartyDetailWithAuthorization(
            { partyRef },
            Redacted.value(transport.authorization),
            scope.correlationId,
            {
              baseUrl: transport.baseUrl,
              compositionRevision: transport.compositionRevision,
            },
          ).pipe(Effect.mapError(unavailable));
          if (!Schema.is(PartyDetailResponseSchema)(detail)) {
            return yield* unavailable();
          }
          const { party, resolution } = detail;
          const canonical = resolution.canonicalPartyRef;
          const direct =
            resolution.kind === 'DIRECT' && resolution.aliasChain.length === 0 && sameRef(canonical, partyRef);
          const firstAlias = resolution.aliasChain.at(0);
          const alias =
            resolution.kind === 'ALIAS' &&
            resolution.aliasChain.length > 0 &&
            firstAlias !== undefined &&
            sameRef(firstAlias, partyRef) &&
            resolution.aliasChain.every((ref) => ref.tenantId === scope.tenantId) &&
            !resolution.aliasChain.some((ref) => sameRef(ref, canonical));
          if (
            !sameRef(resolution.requestedPartyRef, partyRef) ||
            canonical.tenantId !== scope.tenantId ||
            !sameRef(party.partyRef, canonical) ||
            (!direct && !(alias && !canonicalWrite)) ||
            party.partyType !== 'PERSON' ||
            Option.isSome(party.archivedAt)
          ) {
            return yield* unavailable();
          }
          const now = yield* DateTime.now;
          const millis = DateTime.toEpochMillis(now);
          const assertions = detail.currentFactAssertions.filter((assertion) => assertion.factKind === 'PARTY_TYPE');
          if (!currentPersonTypeAssertions(assertions, canonical, millis)) {
            return yield* unavailable();
          }
          return yield* Schema.decodeUnknownEffect(PrivacySubjectOwnerEvidenceSchema)({
            observedAt: DateTime.formatIso(now),
            ownerRevision: party.revision,
            partyRef: canonical,
            typeAssertions: assertions.map((assertion) => ({
              assertionId: assertion.assertionId,
              validFrom: DateTime.formatIso(assertion.validFrom),
              validTo: Option.match(assertion.validTo, { onNone: () => null, onSome: DateTime.formatIso }),
            })),
          }).pipe(Effect.mapError(unavailable));
        },
      ),
    });
  }),
);
