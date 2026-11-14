import { Schema } from 'effect';

import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { AnyReadRegistration, DeclaredReadAccessCarriers } from '../reads/definition.ts';
import { isReadRegistration } from '../reads/definition.ts';

/** An actual registered owner Read, not a key, copied descriptor, or assumed generic read grant. */
export interface ActionGoverningReadRegistration extends AnyReadRegistration {
  readonly descriptor: AnyReadRegistration['descriptor'] &
    DeclaredReadAccessCarriers & {
      readonly legalEntityScope: LegalEntityScope;
    };
}

class GoverningReadReference {
  readonly #registration: ActionGoverningReadRegistration;

  constructor(registration: ActionGoverningReadRegistration) {
    this.#registration = registration;
    Object.freeze(this);
  }

  static registrationOf(reference: GoverningReadReference): ActionGoverningReadRegistration {
    return reference.#registration;
  }
}

/** Immutable authoring reference. It supplies no authority and never invokes the Read's handler. */
export type ActionGoverningReadDeclaration = GoverningReadReference;

const validReference = Schema.is(Schema.instanceOf(GoverningReadReference));
const GoverningReadInvariantError = Schema.TaggedError<Error>()('ActionGoverningReadInvariantError', {
  message: Schema.String,
});

export const defineActionGoverningRead = (
  registration: ActionGoverningReadRegistration,
): ActionGoverningReadDeclaration => {
  if (!isReadRegistration(registration)) {
    throw new GoverningReadInvariantError({
      message: 'An Action governing Read must be an original defineRead registration',
    });
  }
  const { accessDeclaration } = registration.descriptor;
  if (
    accessDeclaration?.kind !== 'read' ||
    !accessDeclaration.modes.includes('run') ||
    accessDeclaration.selectors.length === 0
  ) {
    throw new GoverningReadInvariantError({
      message: 'An Action governing Read must declare a record-scoped read capability in RUN',
    });
  }
  return new GoverningReadReference(registration);
};

/** Internal Core access. Neither a private Read handler nor an owner-supplied authority proof escapes. */
export const getActionGoverningRead = (
  reference: ActionGoverningReadDeclaration | undefined,
): ActionGoverningReadRegistration | undefined =>
  reference === undefined ? undefined : GoverningReadReference.registrationOf(reference);

export const actionGoverningReadIssue = (
  reference: ActionGoverningReadDeclaration | undefined,
  owner: string,
  legalEntityScope: string,
  recordScoped: boolean,
): string | undefined => {
  if (reference === undefined) {
    return undefined;
  }
  if (!validReference(reference)) {
    return 'Action governing Read must be an original immutable declaration';
  }
  const { descriptor } = GoverningReadReference.registrationOf(reference);
  if (descriptor.owningModuleKey !== owner) {
    return 'Action governing Read must belong to the same registered owner';
  }
  if (!recordScoped || descriptor.legalEntityScope !== legalEntityScope) {
    return 'Action governing Read must govern the same record scope as the Action';
  }
  return undefined;
};
