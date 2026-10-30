import type { NodeServices } from '@effect/platform-node';
import type { Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AgentProfileOperatorLive } from './agent-profile-operator.mts';

// Each executable already provides NodeServices at Command.run. All remaining services belong in the operator root.
type UnprovidedOperatorServices = Exclude<
  Layer.Services<typeof AgentProfileOperatorLive>,
  Layer.Success<typeof NodeServices.layer>
>;
const operatorDependenciesAreComplete: [UnprovidedOperatorServices] extends [never] ? true : false = true;

it('the shared admin runtime and CLI Node services provide every required service', () => {
  expect(operatorDependenciesAreComplete).toBe(true);
});
