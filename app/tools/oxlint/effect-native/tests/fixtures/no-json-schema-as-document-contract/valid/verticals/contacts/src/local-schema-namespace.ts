// `Schema` here is a project-local module, not Effect's namespace, and `Json` comes from a
// non-Effect package: nothing on Effect's `Schema` is referenced, so nothing is reported.
import { Json, Schema } from './contacts-json.ts';

export const ContactsDocument = Schema.Record(Schema.String, Schema.Json);
export const AnyJson = Json;
export const decoded = Schema.decodeUnknownSync(Schema.Json)({});
