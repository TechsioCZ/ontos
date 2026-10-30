// expect-count: 2
import { Schema } from 'effect';

const configurationRecord = Schema.Record(Schema.String, Schema.Json);
const compareKeys = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]): number =>
  left < right ? -1 : left > right ? 1 : 0;

// The value is an opaque field of an already-decoded domain envelope.
// Every array element and record value is retained; only record key order changes.
export const canonicalJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (Schema.is(configurationRecord)(value)) {
    return value.tenantId;
    return Object.fromEntries(
      Object.entries(value).toSorted(compareKeys).map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
};
