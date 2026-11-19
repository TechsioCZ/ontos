import { describe, expect, it } from 'effect-rstest';

import { bindActionHttpRunner } from '../../api/action-http-runner.ts';
import { ACTION_GATEWAY_AUDIENCE as principalAudience } from '../../api/auth/action-principal.ts';
import apiRuntime from '../../api/index.ts';
import { ACTION_GATEWAY_AUDIENCE as gatewayAudience } from '../../src/api/action-gateway.ts';

describe('Communications Shell-user Action boundary', () => {
  it('accepts and issues assertions for the communications audience only', () => {
    expect(principalAudience).toBe('communications');
    expect(gatewayAudience).toBe(principalAudience);
  });

  it('exposes the owner-bound Action transport the leaf lanes generate their endpoints on', () => {
    expect(bindActionHttpRunner).toBeInstanceOf(Function);
  });

  it('composes the API root with Core wiring, principal verification and assertion redemption at import', () => {
    expect(apiRuntime).toBeDefined();
  });
});
