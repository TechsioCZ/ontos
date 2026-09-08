// expect-count: 4
import type { JSX } from 'react';

const panelBrand: unique symbol = Symbol('@app/contacts/panel/brand');
const panelHandler: unique symbol = Symbol('@app/contacts/panel/handler');
const panelStream: unique symbol = Symbol('@app/contacts/panel/stream');

export class ContactPanelRegistry {
  readonly [panelBrand]: true = true;
  [panelHandler]: () => Promise<void>;

  constructor(handler: () => Promise<void>) {
    this[panelHandler] = handler;
  }

  async *[panelStream](): AsyncGenerator<string> {
    yield 'contacts';
  }
}

export const registryRecord = (
  handler: () => Promise<void>,
): { readonly [panelHandler]: () => Promise<void> } => ({
  [panelBrand]: true as const,
  [panelHandler]: handler,
});

export const Panel = (): JSX.Element => <div>{String(panelBrand.description)}</div>;
