import { Schema } from 'effect';

import { OccupancyRefSchema } from '../resources/occupancy.ts';

/** Query of the leasing page: an opened lease or counterparty, or a new lease prefilled for a unit. */
export const RecordsSearchSchema = Schema.Struct({
  counterpartyId: Schema.optional(OccupancyRefSchema.fields.resourceId),
  create: Schema.optional(Schema.Literal('lease')),
  resourceId: Schema.optional(OccupancyRefSchema.fields.resourceId),
  unitId: Schema.optional(OccupancyRefSchema.fields.resourceId),
});
export type RecordsSearch = typeof RecordsSearchSchema.Type;

const decodeRecordsSearchParams = Schema.decodeUnknownOption(Schema.fromURLSearchParams(RecordsSearchSchema));

/** Decodes the raw query string ('?…' or '') that the Shell passes to the page and to its preload. */
export const decodeRecordsSearch = (query: string) => decodeRecordsSearchParams(new URLSearchParams(query));
