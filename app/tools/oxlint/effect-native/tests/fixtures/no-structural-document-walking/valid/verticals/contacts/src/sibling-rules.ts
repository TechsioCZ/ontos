import { Predicate, Schema } from 'effect';

/** Owned by no-manual-tag-comparison and the driver-failure rule. */
export const isTagged = (error: object): boolean => '_tag' in error;
export const hasDriverCode = (error: object): boolean => 'code' in error && 'sqlState' in error;
export const hasConstraint = (error: object): boolean => Object.hasOwn(error, 'constraint');

/** A registry lookup with a computed key is a dictionary access, not a hand-written key set. */
export const isKnownCommand = (commands: Record<string, unknown>, name: string): boolean =>
  Object.hasOwn(commands, name);

/** Guards on plain locals stay silent. */
export const asString = (id: unknown): string => (Predicate.isString(id) ? id : '');
export const decodeName = Schema.decodeUnknownSync(Schema.String);
