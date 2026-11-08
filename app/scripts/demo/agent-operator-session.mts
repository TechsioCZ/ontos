import type { TrustedPrincipalContext } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { Effect, Schema } from 'effect';
import { Cookies } from 'effect/http';
import { randomUUID } from 'node:crypto';

import { AuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';

export const AgentProfileSetupError = Schema.TaggedError<unknown>()('AgentProfileSetupError', {
  reason: Schema.String,
});

export interface AgentOperatorSession {
  readonly principal: TrustedPrincipalContext;
  readonly requestHeaders: Headers;
}

export const retainAgentOperatorSessionCookies = Effect.fn('AgentOperatorSetup.retainCookies')(function* retainCookies(
  headers: Headers,
  setCookieHeaders: readonly string[],
) {
  if (setCookieHeaders.length === 0) {
    return;
  }
  const current = yield* Effect.fromResult(
    Cookies.setAll(Cookies.empty, Object.entries(Cookies.parseHeader(headers.get('cookie') ?? ''))),
  ).pipe(
    Effect.mapError(() => new AgentProfileSetupError({ reason: 'The native operator session cookies are invalid' })),
  );
  headers.set('cookie', Cookies.toCookieHeader(Cookies.merge(current, Cookies.fromSetCookie(setCookieHeaders))));
});

/** Select through the actual session. Copying an arbitrary company ID into a principal is not admission. */
export const selectAgentOperatorCompany = Effect.fn('AgentOperatorSetup.selectCompany')(function* selectCompany(
  operator: AgentOperatorSession,
  legalEntityId: string,
) {
  const authentication = yield* AuthenticationService;
  const switched = yield* authentication.switchLegalEntity(legalEntityId, operator.requestHeaders);
  yield* retainAgentOperatorSessionCookies(operator.requestHeaders, switched.setCookieHeaders);
  const selected = yield* authentication.resolveShellContext(operator.requestHeaders);
  yield* retainAgentOperatorSessionCookies(operator.requestHeaders, selected.setCookieHeaders);
  if (
    selected.state !== 'authenticated' ||
    selected.principal.legalEntityId !== legalEntityId ||
    selected.principal.principalId !== operator.principal.principalId ||
    selected.principal.tenantId !== operator.principal.tenantId ||
    selected.principal.authBindingId !== operator.principal.authBindingId
  ) {
    return yield* new AgentProfileSetupError({ reason: 'The authenticated operator could not select this company' });
  }
  return selected.principal;
});

/** Use the same trusted scope and declared Action gate as native execution, including proposal-only denial. */
export const requireAgentSetupAuthority = Effect.fn('AgentOperatorSetup.requireAuthority')(function* requireAuthority(
  principal: TrustedPrincipalContext,
  actionKey: string,
) {
  const resolver = yield* OperationalScopeResolver;
  const authority = yield* ActionAuthority;
  const scope = yield* resolver.resolve({
    correlationId: randomUUID(),
    legalEntityScope: 'required',
    principal,
  });
  const decisions = yield* authority.checkActionAuthorities({ actionKeys: [actionKey], scope });
  if (decisions.length !== 1 || decisions[0]?.actionKey !== actionKey || decisions[0].execute !== 'allowed') {
    return yield* new AgentProfileSetupError({
      reason: 'The authenticated operator cannot execute the native setup Action in this exact company',
    });
  }
  return scope;
});
