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

export type EnrollmentJourneyKind = typeof EnrollmentJourneySchema.Type;

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

const hasDuplicateTransition = (transitions: readonly JourneyTransitionSpec[]): boolean => {
  const identities = transitions.map(journeyTransitionIdentity);
  return new Set(identities).size !== identities.length;
};

/**
 * The declaration rule, exposed as a plain predicate so a journey module, a test and the schema
 * filter all judge a declaration the same way.
 */
export const journeyDefinitionIssue = ({
  optionalTransitions,
  requiredTransitions,
}: JourneyDeclaration): string | undefined => {
  const misplacedRequired = requiredTransitions.some((transition) => !transition.required);
  const misplacedOptional = optionalTransitions.some((transition) => transition.required);
  if (misplacedRequired || misplacedOptional) {
    return 'A journey transition must be declared required exactly when it sits in requiredTransitions';
  }
  if (requiredTransitions.length === 0) {
    return 'A journey must declare at least one required owner transition';
  }
  return hasDuplicateTransition([...requiredTransitions, ...optionalTransitions])
    ? 'A journey must declare every owner transition key at most once'
    : undefined;
};

/**
 * A journey declaration.  `requiredTransitions` gate the Attempt's derived completion; an
 * `optionalTransitions` entry is dispatched when its owner has something to contribute but does
 * not block completion by itself.
 */
export const JourneyDefinitionSchema = Schema.Struct({
  kind: EnrollmentJourneySchema,
  optionalTransitions: Schema.Array(JourneyTransitionSpecSchema),
  requiredTransitions: Schema.Array(JourneyTransitionSpecSchema),
})
  .check(Schema.makeFilter(journeyDefinitionIssue))
  .annotate({ parseOptions: { onExcessProperty: 'error' } });
export type JourneyDefinition = typeof JourneyDefinitionSchema.Type;

/**
 * A journey catalog is an explicit list of declarations.  It is passed in rather than collected
 * from a mutable module registry so that `journeyDefinitionFor` stays a pure lookup, the three
 * journey modules never import one another, and a deployment cannot silently gain a journey by
 * importing a module.
 */
export type JourneyCatalog = readonly JourneyDefinition[];

/**
 * Declare one journey.  The declaration is inert plain data, so this is a naming seam rather than
 * a decoder: `JourneyDefinitionSchema` validates the same shape wherever validation is wanted.
 */
export const defineJourneyDefinition = (definition: JourneyDefinition): JourneyDefinition => definition;

/** The declaration for that journey kind, or `undefined` when the catalog does not carry it. */
export const journeyDefinitionFor = (
  catalog: JourneyCatalog,
  kind: EnrollmentJourneyKind,
): JourneyDefinition | undefined => catalog.find((definition) => definition.kind === kind);

/** A catalog that declares one journey kind twice would shadow a journey, so it is rejected. */
export const journeyCatalogIssue = (catalog: JourneyCatalog): string | undefined => {
  const kinds = catalog.map((definition) => definition.kind);
  return new Set(kinds).size === kinds.length
    ? undefined
    : 'A journey catalog must declare every journey kind at most once';
};

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

/** True when the journey cannot complete without that exact owner transition succeeding. */
export const journeyRequiresTransition = (
  definition: JourneyDefinition,
  ownerModuleKey: string,
  transitionKey: string,
): boolean => journeyTransitionFor(definition, ownerModuleKey, transitionKey)?.required === true;

/** Every declared transition in dispatch order: required first, then optional. */
export const journeyTransitions = (definition: JourneyDefinition): readonly JourneyTransitionSpec[] => [
  ...definition.requiredTransitions,
  ...definition.optionalTransitions,
];
