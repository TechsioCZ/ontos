import {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  LegalEntityCandidates,
  makeTestAccessDecision,
} from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { Layer } from 'effect';

import { DecisionCheck } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import { inertAccessEnforcementPorts } from '../../../../packages/core-runtime/src/testing/access-gate.ts';

/**
 * The one access gate as a native suite wires it: a scripted ALLOWED answer for the capability the
 * read or Action asks about, with the five enforcement ports bound and inert (CUTOVER-PLAN §3.1).
 * A native Commerce Customer Context suite proves the owner path, not the engine, so the gate never
 * reads authority. A suite that must prove a denial provides its own decision instead.
 *
 * `legalEntityIds` is the companies this scripted gate says the caller may select. The production
 * gate answers `selectableLegalEntities` from real v2 intent; a native fixture that creates no
 * assignment must name its own Legal Entity here, or the scope resolver refuses the request before
 * any owner work (O28).
 */
export const allowedAccessLayers = (options: { readonly legalEntityIds?: readonly string[] } = {}) => {
  const ports = inertAccessEnforcementPorts();
  const legalEntityIds = (options.legalEntityIds ?? []).map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId));
  return Layer.mergeAll(
    Layer.succeed(
      AccessDecisionGate,
      makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' }, legalEntityIds }),
    ),
    Layer.succeed(AccessIntent, ports.intent),
    Layer.succeed(AccessDecisionLog, ports.decisionLog),
    Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
    Layer.succeed(DecisionCheck, ports.check),
    Layer.succeed(LegalEntityCandidates, ports.candidates),
  );
};
