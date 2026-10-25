import { GatewayScopeGrantRegistrar } from '@app/core-runtime';
import type { GatewayScopeGrantInput } from '@app/core-runtime';
import { Effect, Layer } from 'effect';

export const noopScopeGrantRegistrar: GatewayScopeGrantRegistrar['Service'] = {
  register: () => Effect.void,
};

/** A test registrar layer for issuer layers that do not assert the persisted grant. */
export const scopeGrantRegistrarLayer = (
  registrar: GatewayScopeGrantRegistrar['Service'] = noopScopeGrantRegistrar,
): Layer.Layer<GatewayScopeGrantRegistrar> => Layer.succeed(GatewayScopeGrantRegistrar, registrar);

export const capturingScopeGrantRegistrar = () => {
  const inputs: GatewayScopeGrantInput[] = [];
  const registrar: GatewayScopeGrantRegistrar['Service'] = {
    register: (input) =>
      Effect.sync(() => {
        inputs.push(input);
      }),
  };
  return { inputs, registrar };
};
