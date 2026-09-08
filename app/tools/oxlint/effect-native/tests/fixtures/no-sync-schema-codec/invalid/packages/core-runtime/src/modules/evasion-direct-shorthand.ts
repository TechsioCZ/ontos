// Object-literal shorthand hands the throwing decoder straight through to callers.
import { decodeUnknownSync, String as Str, Struct } from 'effect/Schema';

const OwnershipSchema = Struct({ owner: Str });

export const ownershipCodecs = { decodeUnknownSync, schema: OwnershipSchema };
