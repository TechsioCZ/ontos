import { Schema, SchemaGetter } from 'effect';

/** URL values stay opaque text; JSON-like IDs must never be coerced into numbers or objects. */
export const CrmRouteSearchSchema = Schema.Struct({
  evidence: Schema.optionalKey(Schema.String),
  hledat: Schema.optionalKey(Schema.String),
  klient: Schema.optionalKey(Schema.String),
  kontakt: Schema.optionalKey(Schema.String),
  obchodnik: Schema.optionalKey(Schema.String),
  obdobi: Schema.optionalKey(Schema.String),
  objednavka: Schema.optionalKey(Schema.String),
  segment: Schema.optionalKey(Schema.String),
  seskupit: Schema.optionalKey(Schema.String),
  stav: Schema.optionalKey(Schema.String),
  zaznamy: Schema.optionalKey(Schema.String),
});
export type CrmRouteSearch = typeof CrmRouteSearchSchema.Type;

const searchFields = [
  'klient',
  'obchodnik',
  'obdobi',
  'objednavka',
  'seskupit',
  'stav',
  'zaznamy',
  'hledat',
  'segment',
  'evidence',
  'kontakt',
] as const;

/** Own the native URL decoding at one Schema boundary, including first-value duplicate-key semantics. */
export const CrmQueryStringSchema = Schema.String.pipe(
  Schema.decodeTo<typeof CrmRouteSearchSchema, typeof Schema.String>(CrmRouteSearchSchema, {
    decode: SchemaGetter.transform((query) => {
      const params = new URLSearchParams(query);
      const fields: typeof CrmRouteSearchSchema.Encoded = {};
      for (const key of searchFields) {
        const value = params.get(key);
        if (value !== null) {
          Object.assign(fields, { [key]: value });
        }
      }
      return fields;
    }),
    encode: SchemaGetter.transform((fields) => {
      const params = new URLSearchParams();
      for (const key of searchFields) {
        const value = fields[key];
        if (value !== undefined) {
          params.set(key, value);
        }
      }
      return params.toString();
    }),
  }),
);

/** Update only explicitly supplied route fields; unrelated parameters remain untouched. */
export const mergeCrmRouteSearch = (
  search: string,
  patch: { readonly [Key in keyof CrmRouteSearch]?: string | undefined },
): string => {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  return params.toString();
};
