import { Schema } from 'effect';

/** Opaque owner-issued reference carried by TAX unchanged. */
export const BoundedIdentifierSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
);

/** Exact owner revision number of a referenced source. */
export const RevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Exact positive base-10 decimal string; never a binary float and never zero. */
export const PositiveDecimalStringSchema = Schema.String.check(
  Schema.isPattern(/^(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)$/u),
);

/** ISO 4217 alphabetic currency code as issued by the owner; TAX never relabels it. */
export const CurrencyCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u));

/** Rejects a collection in which two entries share the same identity. */
export const distinctBy = <Entry>(identityOf: (entry: Entry) => string, message: string) =>
  Schema.makeFilter((entries: readonly Entry[]) => new Set(entries.map(identityOf)).size === entries.length || message);
