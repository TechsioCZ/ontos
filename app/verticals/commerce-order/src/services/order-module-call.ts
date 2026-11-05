import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Match } from 'effect';
import type { Data } from 'effect';
import type { OrderFinalizationContext } from '../../shared/domain/order-finalization-evidence.ts';
import type { ActionInvocationIdSchema } from '../../shared/domain/order-commitment.ts';

export { ActionInvocationIdSchema } from '../../shared/domain/order-commitment.ts';
type ActionInvocationId = typeof ActionInvocationIdSchema.Type;

/**
 * Whom an outgoing module call is made for (DESIGN D2, D7). `Assertion` relays the verified scope of a
 * live request this module received; `Originator` names the action invocation whose subject the work
 * acts for. Runtime-only: a caller is never serialized into a response, an intent or a row.
 */
export type OrderModuleCaller = Data.TaggedEnum<{
  Assertion: { readonly scope: TrustedPrincipalContext };
  Originator: { readonly actionInvocationId: ActionInvocationId };
}>;

/** Business context plus the caller that the calls made with it act for. */
export type OrderFinalizationCall = OrderFinalizationContext & { readonly caller: OrderModuleCaller };

export const callAs = (context: OrderFinalizationContext, caller: OrderModuleCaller): OrderFinalizationCall => ({
  ...context,
  caller,
});

/** The delegation subject for one outgoing call; an originator takes the release it was admitted under. */
export const delegationSubject = (
  caller: OrderModuleCaller,
  origin: { readonly compositionRevision: string; readonly tenantId: string },
): GatewayDelegationSubject =>
  Match.value(caller).pipe(
    Match.tag('Assertion', (assertion): GatewayDelegationSubject => ({ _tag: 'Assertion', scope: assertion.scope })),
    Match.tag('Originator', (originator): GatewayDelegationSubject => ({
      _tag: 'Originator',
      actionInvocationId: originator.actionInvocationId,
      compositionRevision: origin.compositionRevision,
      tenantId: origin.tenantId,
    })),
    Match.exhaustive,
  );
