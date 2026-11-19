import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { submitCommunicationRequestAction } from '../../src/actions/submit-communication-request.action.ts';
import { callerIsClaimedSource, sourceCallerOf, verifiedCallerModuleOf } from '../../src/integrations/source-caller.ts';
import { asSourceAdmission, asSourceWorker } from '../support/source-worker-principal.ts';

const REVISION = 'a'.repeat(64);
const TENANT = '11111111-1111-4111-8111-111111111111';
const systemPrincipal = () =>
  ({
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authContextRef: 'job:communications-intake-tests:run:60000000-0000-4000-8000-000000000002',
      authMethod: 'system',
      principalId: '77777777-7777-4777-8777-777777777777',
      tenantId: TENANT,
    }),
    correlationId: 'source-caller-test',
  }) as const;
const sessionPrincipal = () =>
  ({
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: '99999999-9999-4999-8999-999999999999',
      authContextRef: 'better-auth-session:fixture-human',
      authMethod: 'session',
      principalId: '88888888-8888-4888-8888-888888888888',
      tenantId: TENANT,
    }),
    correlationId: 'source-caller-test',
  }) as const;

/**
 * `source.moduleKey` is only a claim of the issuer. These tests drive the REAL provenance carrier of Core
 * (`readVerifiedGatewayWorkload`) with a context sealed the way the Shell seals a registered source worker's delivery.
 */
describe('The source module claimed by a Communication Request is bound to the verified caller (#1401 F2)', () => {
  it('admits the claim only from the very module Core verified as the calling source worker', () => {
    const worker = asSourceWorker(systemPrincipal(), 'fixture.source', REVISION);
    expect(Option.getOrUndefined(verifiedCallerModuleOf(worker))).toBe('fixture.source');
    expect(callerIsClaimedSource(worker, 'fixture.source')).toBe(true);
    expect(sourceCallerOf(worker).isClaimedSource('fixture.source')).toBe(true);
  });

  it('refuses a caller that claims another source module, however well it is registered itself', () => {
    const worker = asSourceWorker(systemPrincipal(), 'fixture.source', REVISION);
    expect(callerIsClaimedSource(worker, 'fixture.other-source')).toBe(false);
    expect(callerIsClaimedSource(worker, 'fixture.sourc')).toBe(false);
    expect(callerIsClaimedSource(worker, '')).toBe(false);
    expect(sourceCallerOf(worker).isClaimedSource('communications.core')).toBe(false);
  });

  it('refuses a context with no verified worker: a plain system principal, a copy of a sealed one, an admission, a person', () => {
    const worker = asSourceWorker(systemPrincipal(), 'fixture.source', REVISION);
    // a copy of the sealed context is a different object: the seal is Core's, a payload or a spread cannot carry it
    expect(callerIsClaimedSource({ ...worker }, 'fixture.source')).toBe(false);
    expect(callerIsClaimedSource(systemPrincipal(), 'fixture.source')).toBe(false);
    // a registered admission calls directly, not from a source's own delivery: it names no module and is refused
    const admission = asSourceAdmission(systemPrincipal(), REVISION);
    expect(Option.isNone(verifiedCallerModuleOf(admission))).toBe(true);
    expect(callerIsClaimedSource(admission, 'fixture.source')).toBe(false);
    // a human session principal names no source module at all
    expect(callerIsClaimedSource(sessionPrincipal(), 'fixture.source')).toBe(false);
  });

  it('is declared on a workload-only carrier, so Core refuses a person before the handler is ever reached', () => {
    const { descriptor } = submitCommunicationRequestAction;
    expect(descriptor.accessWorkload?.workloads).toEqual(['communications.core.request-source']);
    // no `accessDeclaration` beside it: a v2 grant can never admit a human or an agent on this Action (O59, O67-Q4)
    expect(Object.hasOwn(descriptor, 'accessDeclaration')).toBe(false);
    // The refusal itself (a human on a workload carrier -> 403 `deny.workload_only`, handler not reached) is proved by
    // Core's own `action-access-gate.test.ts`; the Core test harness here scripts the access decision and cannot run it.
  });
});
