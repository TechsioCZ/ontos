import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { issueDelegatedGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Crypto, Effect } from 'effect';
import type { Redacted, Schema } from 'effect';

/** Request a fresh real Shell signature; this helper never creates or attaches trusted provenance. */
export const issueSymmyC14RecoveryAssertion = Effect.fn('SymmyC14Recovery.issue')(function* issueRecovery(input: {
  readonly audience: string;
  readonly compositionRevision: string;
  readonly declarationKey: string;
  readonly legalEntityScope?: 'subject' | 'tenant';
  readonly moduleKey: Redacted.Redacted;
  readonly operationRequirementKey?: string;
  readonly originalActionKey: string;
  readonly originalIdempotencyKey: string;
  readonly originalPrincipalId: string;
  readonly originalRequestHash: string;
  readonly readPayload: Schema.Json;
  readonly shellGatewayBaseUrl: string;
  readonly source: Extract<
    Parameters<typeof issueDelegatedGatewayContext>[0]['subject'],
    { readonly _tag: 'RegisteredRecovery' }
  >['source'];
}) {
  const crypto = yield* Crypto.Crypto;
  const requestHash = computeCanonicalValueHash(input.readPayload);
  const exchangeId = yield* crypto.randomUUIDv4();
  const requestCorrelation = yield* crypto.randomUUIDv4();
  let subject: Extract<
    Parameters<typeof issueDelegatedGatewayContext>[0]['subject'],
    { readonly _tag: 'RegisteredRecovery' }
  > = {
    _tag: 'RegisteredRecovery',
    declarationKey: input.declarationKey,
    originalActionKey: input.originalActionKey,
    originalIdempotencyKey: input.originalIdempotencyKey,
    originalPrincipalId: input.originalPrincipalId,
    originalRequestHash: input.originalRequestHash,
    requestHash,
    source: input.source,
  };
  if (input.operationRequirementKey !== undefined) {
    subject = { ...subject, operationRequirementKey: input.operationRequirementKey };
  }
  return yield* issueDelegatedGatewayContext(
    {
      audience: input.audience,
      compositionRevision: input.compositionRevision,
      exchangeId,
      legalEntityScope: input.legalEntityScope ?? 'tenant',
      subject,
    },
    { apiKey: input.moduleKey, baseUrl: input.shellGatewayBaseUrl, requestCorrelation },
  );
});
