import type { JSX } from 'react';

const brand: unique symbol = Symbol('@app/contacts/brand');

export interface ContactCard {
  readonly [brand]: true;
  readonly name: string;
}

/** A JSX/TSX file with a branded record and named fields reports nothing. */
export const Panel = ({ card }: { readonly card: ContactCard }): JSX.Element => (
  <div className="contact-card">{card.name}</div>
);
