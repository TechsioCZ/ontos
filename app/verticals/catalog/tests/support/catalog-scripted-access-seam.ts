import { bindAccessGate } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { inertAccessEnforcementPorts, makeTestAccessGateLayers } from '@app/core-runtime/testing/access-gate';
import type { TestAccessGateScript } from '@app/core-runtime/testing/access-gate';
import { Context, Effect, Layer } from 'effect';

/**
 * One Catalog receiver's scripted access gate, bound once (CUTOVER-PLAN §3.1 step 8). The receiver's
 * owned database carries no v2 access intent and reaches no engine, so the seam answers the script it
 * declares — ALLOWED for the admitted actor, DENIED for the principals it names — while the real scope
 * resolver still asks it which companies the actor may select (O28).
 *
 * The seam is bound here and the Action runner is handed the bound gate. A live authority preparation
 * cannot rebind a double, so asking the runner to prepare persisted authority the receiver never
 * declared could only answer a retryable 503. Binding is the receiver's own explicit port: it weakens
 * nothing in the production refusal and teaches the double no preparation it does not have.
 */
export const makeCatalogScriptedAccess = Effect.fn('Catalog.scriptedAccess')(function* makeCatalogScriptedAccess(
  script: TestAccessGateScript,
) {
  const services = yield* Layer.build(makeTestAccessGateLayers(script));
  return Object.freeze({
    bound: bindAccessGate(Context.get(services, AccessDecisionGate), inertAccessEnforcementPorts()),
    services,
  });
});
