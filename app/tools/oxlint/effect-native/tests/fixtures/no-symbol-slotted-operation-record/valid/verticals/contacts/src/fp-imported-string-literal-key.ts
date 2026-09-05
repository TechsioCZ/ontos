// False positive (adversarial review): TypeScript accepts a computed key in an interface for a
// `unique symbol` *or* a literal-typed constant, and the rule treats both as a cross-module symbol
// slot. `routeNamespace` is provably the string 'contacts' (see ./fp-route-metadata.ts), the slot
// holds i18n resources rather than an operation capability, and the member read is a plain
// string-keyed property access — yet all three lines report `importedSymbolSlot`/`symbolSlotAccess`.
// This is the i18n namespace shape already used at verticals/contacts/src/modern.runtime.ts:32 and
// apps/shell-super-app/src/modern.runtime.ts:25, one interface declaration away from firing.
import { routeNamespace } from './fp-route-metadata.ts';

export interface LocaleResources {
  readonly [routeNamespace]: Readonly<Record<string, string>>;
}

export const resources: LocaleResources = { [routeNamespace]: { title: 'Contacts' } };

export const namespaceOf = (bundle: LocaleResources): Readonly<Record<string, string>> =>
  bundle[routeNamespace];
