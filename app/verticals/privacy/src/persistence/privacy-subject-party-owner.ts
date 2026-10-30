import { PartyDetailResponseSchema, executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import type { OperationalScope } from '@app/core-runtime';
import { Context, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';

import type { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import { PrivacyPartyRefSchema as PartyRefSchema } from '../../shared/domain/party-reference.ts';
import { PrivacySubjectOwnerEvidenceSchema } from '../../shared/domain/privacy-subject.ts';
import type { PrivacySubjectOwnerEvidence } from '../../shared/domain/privacy-subject.ts';
import { PrivacySubjectPartyCredentials } from './privacy-subject-party-credentials.ts';
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
    ) => Effect.Effect<PrivacySubjectOwnerEvidence, PrivacyOperationPersistenceError>;
  }
>()('@app/privacy/persistence/privacy-subject-party-owner/PrivacySubjectPartyOwner') {}

export const privacySubjectPartyOwnerUnavailable = PrivacySubjectPartyOwner.of({
  resolve: () => Effect.fail(unavailable()),
});
export const PrivacySubjectPartyOwnerUnavailableLive = Layer.succeed(
  PrivacySubjectPartyOwner,
  privacySubjectPartyOwnerUnavailable,
);

/** Uses the published generated owner client; ordinary detail requires no privileged fact history. */
export const PrivacySubjectPartyOwnerLive = Layer.effect(
  PrivacySubjectPartyOwner,
  Effect.gen(function* partyOwnerClient() {
    const credentials = yield* PrivacySubjectPartyCredentials;
    const sameRef = Schema.toEquivalence(Schema.toEncoded(PartyRefSchema));
    return PrivacySubjectPartyOwner.of({
      resolve: Effect.fn('PrivacySubjectPartyOwner.resolve')(
        function* resolvePartyOwner(partyRef, scope, canonicalWrite) {
          if (partyRef.tenantId !== scope.tenantId) {
            return yield* unavailable();
          }
          const transport = yield* credentials.acquire(scope);
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
          if (
            assertions.length === 0 ||
            assertions.some(
              (assertion) =>
                !sameRef(assertion.partyRef, canonical) ||
                assertion.value !== 'PERSON' ||
                assertion.state !== 'ACTIVE' ||
                !assertion.isCurrent ||
                DateTime.toEpochMillis(assertion.validFrom) > millis ||
                Option.exists(assertion.validTo, (end) => DateTime.toEpochMillis(end) <= millis),
            )
          ) {
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
