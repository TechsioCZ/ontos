// Direct member imports of the Schema module are understood, so the Effect-native spelling of the
// same contract must stay silent — and a locally declared `Struct` is not Effect's.
import { DateTimeUtc, NullOr, OptionFromNullOr, String as SchemaString, Struct } from 'effect/Schema';

export const ApiKeySchema = Struct({
  createdAt: DateTimeUtc,
  revokedAt: OptionFromNullOr(DateTimeUtc),
  expiresAt: NullOr(DateTimeUtc),
  name: SchemaString,
  format: SchemaString,
});

export function localShadow(): unknown {
  const Struct = (fields: Record<string, unknown>): Record<string, unknown> => fields;
  return Struct({ createdAt: 'not a schema at all', expiresAt: 'still not' });
}
