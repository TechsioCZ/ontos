import { Predicate } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { PrincipalContextProvenance } from './system-principal-context-provenance.ts';

const provenanceProperty = '__ontosCorePrincipalContextProvenance';

/**
 * Provenance sealed in a class only this module constructs. The private-field brand check rejects
 * look-alike objects, and the carrier identity check rejects transplanted property descriptors.
 * The non-enumerable seal does not survive ordinary copies; explicit trusted copies get a new seal.
 */
class PrincipalContextProvenanceSeal {
  readonly #carrier: TrustedPrincipalContext;
  readonly #provenance: PrincipalContextProvenance;

  constructor(carrier: TrustedPrincipalContext, provenance: PrincipalContextProvenance) {
    this.#carrier = carrier;
    this.#provenance = Object.freeze(provenance);
    Object.freeze(this);
  }

  static read(carrier: TrustedPrincipalContext): PrincipalContextProvenance | undefined {
    const seal: unknown = Object.getOwnPropertyDescriptor(carrier, provenanceProperty)?.value;
    return Predicate.isObject(seal) && #provenance in seal && seal.#carrier === carrier ? seal.#provenance : undefined;
  }
}

/** Attaches provenance to a carrier the caller has just created. */
export const sealPrincipalContextProvenance = (
  carrier: TrustedPrincipalContext,
  provenance: PrincipalContextProvenance,
): void => {
  Object.defineProperty(carrier, provenanceProperty, {
    value: new PrincipalContextProvenanceSeal(carrier, provenance),
  });
};

/** Returns the provenance sealed on this exact carrier, if any. */
export const readPrincipalContextProvenanceSeal = (
  carrier: TrustedPrincipalContext,
): PrincipalContextProvenance | undefined => PrincipalContextProvenanceSeal.read(carrier);
