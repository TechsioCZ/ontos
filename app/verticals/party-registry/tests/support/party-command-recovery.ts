import { Schema } from 'effect';

import { ActionInvocationIdSchema } from '../../shared/domain/correction-contracts.ts';

/** The one Party command invocation every recovery case resolves. */
export const invocationId = Schema.decodeSync(ActionInvocationIdSchema)('10000000-0000-4000-8000-000000000001');
export const compositionRevision = 'a'.repeat(64);

export const recoveryCredential = (jti: string, signature = 'signature') =>
  `Bearer ${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ jti }))}.${signature}`;

/** The Party owner admits each recovery credential once, as its single-use `jti` redemption does. */
export const makeSingleUseOwnerResponse = (ownerResponse: (request: Request) => Response) => {
  const consumedJtis = new Set<string>();
  const rejectedJtis: string[] = [];
  const respond = (request: Request) => {
    const encodedPayload = request.headers.get('authorization')?.split('.')[1];
    if (encodedPayload === undefined) {
      throw new Error('Expected a JWT credential');
    }
    const { jti } = Schema.decodeUnknownSync(Schema.Struct({ jti: Schema.String }))(JSON.parse(atob(encodedPayload)));
    if (consumedJtis.has(jti)) {
      rejectedJtis.push(jti);
      return Response.json(
        {
          _tag: 'PartyMatchDecisionAuthenticationProblem',
          detail: 'This single-use credential was already consumed.',
          status: 401,
          title: 'Credential already consumed',
          type: 'urn:ontos:party:credential-consumed',
        },
        { headers: { 'content-type': 'application/problem+json' }, status: 401 },
      );
    }
    consumedJtis.add(jti);
    return ownerResponse(request);
  };
  return { consumedJtis, rejectedJtis, respond };
};

/** The exact original Create result the Party owner retains with the committed invocation. */
export const createResult = (outcome: 'CREATED' | 'MATCHED_EXISTING' | 'AMBIGUOUS') => {
  const partyRef = {
    moduleId: 'party.registry',
    resourceId: invocationId,
    resourceType: 'party.registry.party',
    tenantId: invocationId,
  };
  const decisionRef = { ...partyRef, resourceType: 'party.registry.party-match-decision' };
  return outcome === 'AMBIGUOUS'
    ? { outcome, decisionRef, caseRef: { ...partyRef, resourceType: 'party.registry.duplicate-candidate-case' } }
    : { outcome, decisionRef, partyRef };
};
