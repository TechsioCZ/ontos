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
 * The seam is bound here, over ports without persisted currentness, and the Action runner is handed the
 * bound gate: the runner takes the scripted decision path and never prepares persisted authority the
 * receiver never declared. Binding is the receiver's own explicit port. It weakens nothing in the
 * production refusal, which still refuses any gate that cannot rebind to the caller's transaction.
 */
export class CatalogScriptedAccess extends Context.Service<
  CatalogScriptedAccess,
  {
    readonly bound: ReturnType<typeof bindAccessGate>;
    readonly services: Context.Context<Layer.Success<ReturnType<typeof makeTestAccessGateLayers>>>;
  }
>()('@app/catalog/tests/support/catalog-scripted-access-seam/CatalogScriptedAccess') {}

export const catalogScriptedAccessLayer = (script: TestAccessGateScript) =>
  Layer.effect(
    CatalogScriptedAccess,
    Effect.gen(function* catalogScriptedAccess() {
      const services = yield* Layer.build(makeTestAccessGateLayers(script));
      return Object.freeze({
        bound: bindAccessGate(Context.get(services, AccessDecisionGate), inertAccessEnforcementPorts()),
        services,
      });
    }),
  );
