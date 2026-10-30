import { Schema, SchemaGetter } from 'effect';

/** URL values stay opaque text; JSON-like IDs must never be coerced into numbers or objects. */
export const CrmRouteSearchSchema = Schema.Struct({
  klient: Schema.optionalKey(Schema.String),
  obchodnik: Schema.optionalKey(Schema.String),
  obdobi: Schema.optionalKey(Schema.String),
  objednavka: Schema.optionalKey(Schema.String),
  seskupit: Schema.optionalKey(Schema.String),
  stav: Schema.optionalKey(Schema.String),
});
export type CrmRouteSearch = typeof CrmRouteSearchSchema.Type;

const searchFields = ['klient', 'obchodnik', 'obdobi', 'objednavka', 'seskupit', 'stav'] as const;

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
