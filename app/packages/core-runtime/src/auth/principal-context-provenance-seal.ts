import { Predicate } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { PrincipalContextProvenance } from './system-principal-context-provenance.ts';

const provenanceProperty = '__ontosCorePrincipalContextProvenance';

/**
 * Provenance sealed in a class only this module constructs. The private-field brand check rejects
 * look-alike objects, and the carrier holds the seal in a non-enumerable property, so a copy of a
 * carrier (spread, decode, structured clone) is a new object without provenance.
 */
class PrincipalContextProvenanceSeal {
  readonly #provenance: PrincipalContextProvenance;

  constructor(provenance: PrincipalContextProvenance) {
    this.#provenance = Object.freeze(provenance);
    Object.freeze(this);
  }

  static read(carrier: TrustedPrincipalContext): PrincipalContextProvenance | undefined {
    const seal: unknown = Object.getOwnPropertyDescriptor(carrier, provenanceProperty)?.value;
    return Predicate.isObject(seal) && #provenance in seal ? seal.#provenance : undefined;
  }
}

/** Attaches provenance to a carrier the caller has just created. */
export const sealPrincipalContextProvenance = (
  carrier: TrustedPrincipalContext,
  provenance: PrincipalContextProvenance,
): void => {
  Object.defineProperty(carrier, provenanceProperty, { value: new PrincipalContextProvenanceSeal(provenance) });
};

/** Returns the provenance sealed on this exact carrier, if any. */
export const readPrincipalContextProvenanceSeal = (
  carrier: TrustedPrincipalContext,
): PrincipalContextProvenance | undefined => PrincipalContextProvenanceSeal.read(carrier);
