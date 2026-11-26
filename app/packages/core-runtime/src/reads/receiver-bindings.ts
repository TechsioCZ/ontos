import { Result, Schema } from 'effect';

import { RECEIVING_HOST_CALLER_BINDING, decodeAccessActor } from '../authorization/access-declaration.ts';
import type { AccessActor } from '../authorization/access-declaration.ts';
import { isGenuineCoreOperation } from '../modules/module-operation-execution.ts';
import { governedReadRegistration, isReadRegistration } from './definition.ts';
import type { AnyReadRegistration } from './definition.ts';
import { ReadDefinitionInvariantError } from './read-definition-invariant-error.ts';
import { readAccessQuestionTarget } from './access-questions.ts';
import type { MaterializedAccessQuestion } from './sdk-contract.ts';

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

/** Public, declaration-emittable service contract; capture still requires the privately minted implementation. */
export interface CoreReadReceiverBindingRegistry {
  readonly actorFor: (registration: AnyReadRegistration) => AccessActor | undefined;
}

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
    if (actors.has(registration)) {
      return invalidBinding('A Core read may have only one receiver binding');
    }
    if (!isReadRegistration(registration) || !isGenuineCoreOperation(registration)) {
      return invalidBinding('A receiver binding requires an original Core read registration');
    }
    const { accessActor, entrypoint } = governedReadRegistration(registration).descriptor;
    if (accessActor?.callerBinding !== RECEIVING_HOST_CALLER_BINDING) {
      return invalidBinding('A receiver binding requires a host-bound Core read');
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
  return accessActor?.callerBinding === RECEIVING_HOST_CALLER_BINDING
    ? (bindings?.actorFor(registration) ?? accessActor)
    : accessActor;
};
/** Bind questions only by the original registered target, never by matching carrier strings. */
export const resolveCoreReadAccessQuestions = (
  questions: readonly MaterializedAccessQuestion[],
  bindings: CoreReadReceiverBindingRegistry | undefined,
): readonly MaterializedAccessQuestion[] =>
  bindings === undefined
    ? questions
    : questions.map((question) => {
        const target = readAccessQuestionTarget(question);
        if (!isReadRegistration(target)) {
          return question;
        }
        const accessActor = bindings.actorFor(target);
        return accessActor === undefined
          ? question
          : Object.freeze({ ...question, carrier: Object.freeze({ ...question.carrier, accessActor }) });
      });
