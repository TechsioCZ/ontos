import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ActionInvocationIdSchema, delegationSubject } from '../../src/services/order-module-call.ts';

const scope = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'api-key:module-call-fixture',
  authenticationNamespaceId: 'order-module-call-fixture',
  authMethod: 'api_key',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '50000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
});
const origin = { compositionRevision: 'a'.repeat(64), tenantId: '40000000-0000-4000-8000-000000000001' };
const invocationId = Schema.decodeUnknownSync(ActionInvocationIdSchema)('80000000-0000-4000-8000-0000000000a1');

const relayedScope = (subject: GatewayDelegationSubject) =>
  Match.value(subject).pipe(
    Match.tag('Assertion', (assertion) => assertion.scope),
    Match.orElse(() => null),
  );
const originatorFields = (subject: GatewayDelegationSubject) =>
  Match.value(subject).pipe(
    Match.tag('Originator', (originator) => ({
      actionInvocationId: originator.actionInvocationId,
      compositionRevision: originator.compositionRevision,
      tenantId: originator.tenantId,
    })),
    Match.orElse(() => null),
  );

describe('Order module call subject', () => {
  it('relays a live Assertion with the same verified scope object', () => {
    const subject = delegationSubject({ _tag: 'Assertion', scope }, origin);
    expect(relayedScope(subject)).toBe(scope);
  });
  it('names the delivering invocation for an Originator, bound to the release it was admitted under', () => {
    const subject = delegationSubject({ _tag: 'Originator', actionInvocationId: invocationId }, origin);
    expect(originatorFields(subject)).toEqual({
      actionInvocationId: invocationId,
      compositionRevision: origin.compositionRevision,
      tenantId: origin.tenantId,
    });
  });
});
