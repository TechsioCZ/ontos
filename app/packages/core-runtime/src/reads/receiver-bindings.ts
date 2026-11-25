import { Result, Schema } from 'effect';

import { decodeAccessActor } from '../authorization/access-declaration.ts';
import type { AccessActor } from '../authorization/access-declaration.ts';
import { isGenuineCoreOperation } from '../modules/module-operation-execution.ts';
import { governedReadRegistration, isReadRegistration } from './definition.ts';
import type { AnyReadRegistration } from './definition.ts';
import { ReadDefinitionInvariantError } from './read-definition-invariant-error.ts';

export { CoreReadReceiverBindings } from './receiver-bindings-context.ts';

export interface CoreReadReceiverBinding {
  readonly callers: readonly [string, ...string[]];
  readonly registration: AnyReadRegistration;
}

const receiverBindingMint = Symbol('CoreReadReceiverBindings');

class CoreReadReceiverBindingSet {
  readonly #actors: ReadonlyMap<AnyReadRegistration, AccessActor>;

  constructor(actors: ReadonlyMap<AnyReadRegistration, AccessActor>, mint: typeof receiverBindingMint) {
    if (mint !== receiverBindingMint) {
      throw new ReadDefinitionInvariantError({ message: 'Receiver bindings must be constructed by their host API' });
    }
    this.#actors = actors;
    Object.freeze(this);
  }

  static owns(value: CoreReadReceiverBindingSet): boolean {
    return #actors in value;
  }

  actorFor(registration: AnyReadRegistration): AccessActor | undefined {
    return this.#actors.get(registration);
  }
}
Object.freeze(CoreReadReceiverBindingSet.prototype);
Object.freeze(CoreReadReceiverBindingSet);

export type CoreReadReceiverBindingRegistry = CoreReadReceiverBindingSet;

const isReceiverBindingSet = Schema.is(
  Schema.instanceOf(CoreReadReceiverBindingSet).check(
    Schema.makeFilter((value) =>
      CoreReadReceiverBindingSet.owns(value) ? undefined : 'Expected genuine receiver bindings',
    ),
  ),
);

const invalidBinding = (message: string): never => {
  throw new ReadDefinitionInvariantError({ message });
};

/** Trusted host wiring; only original Core reads may receive an explicit host-bound actor. */
export const makeCoreReadReceiverBindings = (
  bindings: readonly CoreReadReceiverBinding[],
): CoreReadReceiverBindingRegistry => {
  const actors = new Map<AnyReadRegistration, AccessActor>();
  for (const { callers, registration } of bindings) {
    if (!isReadRegistration(registration) || !isGenuineCoreOperation(registration)) {
      return invalidBinding('A receiver binding requires an original Core read registration');
    }
    const { accessActor, entrypoint } = governedReadRegistration(registration).descriptor;
    if (accessActor?.callerBinding !== 'receiving-host' || actors.has(registration)) {
      return invalidBinding('A receiver binding requires one unique host-bound Core read');
    }
    const decoded = decodeAccessActor(
      { callers, reason: accessActor.reason, subject: accessActor.subject },
      entrypoint,
    );
    if (Result.isFailure(decoded)) {
      return invalidBinding(decoded.failure.reason);
    }
    actors.set(registration, decoded.success);
  }
  return new CoreReadReceiverBindingSet(actors, receiverBindingMint);
};

/** Capture only registries minted by the host constructor, never a forged service-shaped object. */
export const captureCoreReadReceiverBindings = (
  bindings: CoreReadReceiverBindingRegistry | undefined,
): CoreReadReceiverBindingRegistry | undefined => {
  if (bindings !== undefined && !isReceiverBindingSet(bindings)) {
    return invalidBinding('Expected genuine Core read receiver bindings');
  }
  return bindings;
};

/** Resolve only the transient gate actor. An unbound actor retains its empty, deny-all caller tuple. */
export const resolveCoreReadReceiverActor = (
  registration: AnyReadRegistration,
  bindings: CoreReadReceiverBindingRegistry | undefined,
): AccessActor | undefined => {
  const { accessActor } = governedReadRegistration(registration).descriptor;
  return accessActor?.callerBinding === 'receiving-host'
    ? (bindings?.actorFor(registration) ?? accessActor)
    : accessActor;
};
