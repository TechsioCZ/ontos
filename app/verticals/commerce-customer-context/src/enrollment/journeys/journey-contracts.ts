import { Schema } from 'effect';

import {
  EnrollmentJourneySchema,
  EnrollmentModuleKeySchema,
  EnrollmentTransitionKeySchema,
} from '../../../shared/enrollment-contracts.ts';

/**
 * Journey vocabulary shared by the three supported enrollment journeys (Retail self-enrollment,
 * Counterparty invitation, Existing account).  A journey declaration is data only: it names which
 * owner transitions are required and which are optional.  It never performs an owner effect, never
 * carries credentials or provider payloads, and never decides an owner outcome.
 *
 * The declarations exist so a caller can reason about an Attempt before any owner effect runs:
 * every dispatched transition still travels through the owner-transition driver, and the driver's
 * durable claim is the only authority that can record an owner outcome.
 */

/**
 * Module and transition keys keep their bounded, trimmed validation but stay plain strings in the
 * declaration: a journey declaration is inert data that every consumer re-decodes at its own
 * boundary, so branding here would only force every journey module to decode a literal twice.
 */
const JourneyTransitionSpecSchema = Schema.Struct({
  /** Owner module that dispatches this transition, e.g. `commerce.portal-auth`. */
  ownerModuleKey: Schema.toEncoded(EnrollmentModuleKeySchema),
  /** Whether the journey cannot complete without this transition succeeding. */
  required: Schema.Boolean,
  /** Stable transition identity inside the owner module, e.g. `provider.account.create`. */
  transitionKey: Schema.toEncoded(EnrollmentTransitionKeySchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type JourneyTransitionSpec = typeof JourneyTransitionSpecSchema.Type;

const transitionIdentity = (ownerModuleKey: string, transitionKey: string): string =>
  `${ownerModuleKey}\u0000${transitionKey}`;

/** Stable identity of one journey transition, usable as a map key without exposing either part. */
export const journeyTransitionIdentity = (transition: JourneyTransitionSpec): string =>
  transitionIdentity(transition.ownerModuleKey, transition.transitionKey);

interface JourneyDeclaration {
  readonly optionalTransitions: readonly JourneyTransitionSpec[];
  readonly requiredTransitions: readonly JourneyTransitionSpec[];
}

/**
 * A journey declaration.  `requiredTransitions` gate the Attempt's derived completion; an
 * `optionalTransitions` entry is dispatched when its owner has something to contribute but does
 * not block completion by itself.  The filter is the whole declaration rule: a transition sits in
 * the list its own `required` flag names, a journey gates on at least one transition, and it names
 * every owner transition at most once so one step can never be proven twice.
 */
export const JourneyDefinitionSchema = Schema.Struct({
  kind: EnrollmentJourneySchema,
  optionalTransitions: Schema.Array(JourneyTransitionSpecSchema),
  requiredTransitions: Schema.Array(JourneyTransitionSpecSchema),
})
  .check(
    Schema.makeFilter(({ optionalTransitions, requiredTransitions }: JourneyDeclaration): string | undefined => {
      if (
        requiredTransitions.some((transition) => !transition.required) ||
        optionalTransitions.some((transition) => transition.required)
      ) {
        return 'A journey transition must be declared required exactly when it sits in requiredTransitions';
      }
      if (requiredTransitions.length === 0) {
        return 'A journey must declare at least one required owner transition';
      }
      const identities = [...requiredTransitions, ...optionalTransitions].map(journeyTransitionIdentity);
      return new Set(identities).size === identities.length
        ? undefined
        : 'A journey must declare every owner transition key at most once';
    }),
  )
  .annotate({ parseOptions: { onExcessProperty: 'error' } });
export type JourneyDefinition = typeof JourneyDefinitionSchema.Type;

/** The declared transition, or `undefined` when the journey does not own that exact pair. */
export const journeyTransitionFor = (
  definition: JourneyDefinition,
  ownerModuleKey: string,
  transitionKey: string,
): JourneyTransitionSpec | undefined => {
  const identity = transitionIdentity(ownerModuleKey, transitionKey);
  return [...definition.requiredTransitions, ...definition.optionalTransitions].find(
    (transition) => journeyTransitionIdentity(transition) === identity,
  );
};

/** Every declared transition in dispatch order: required first, then optional. */
export const journeyTransitions = (definition: JourneyDefinition): readonly JourneyTransitionSpec[] => [
  ...definition.requiredTransitions,
  ...definition.optionalTransitions,
];
