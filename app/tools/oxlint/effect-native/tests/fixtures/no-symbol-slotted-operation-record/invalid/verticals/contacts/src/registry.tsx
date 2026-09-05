// expect-count: 3
import type { JSX } from 'react';

const contactBrand: unique symbol = Symbol('@app/contacts/brand');
const contactOperation: unique symbol = Symbol('@app/contacts/operation');
const contactRenderer: unique symbol = Symbol('@app/contacts/renderer');

export class ContactOperationRegistry {
  // allowed: nominal marker
  readonly [contactBrand]: true = true;
  // reported: a capability stored on a class under a unique-symbol slot
  [contactOperation]: () => Promise<void>;

  constructor(handler: () => Promise<void>) {
    // allowed by default (allowSameFileAccessors)
    this[contactOperation] = handler;
  }

  // reported: a method slot is never a brand marker
  [contactRenderer](): JSX.Element {
    return <span>contacts</span>;
  }
}

// reported: an operation record keyed by `symbol`
export interface ContactOperationTable {
  readonly [slot: symbol]: () => Promise<void>;
}

export const Panel = (): JSX.Element => <div>{String(contactBrand.description)}</div>;
