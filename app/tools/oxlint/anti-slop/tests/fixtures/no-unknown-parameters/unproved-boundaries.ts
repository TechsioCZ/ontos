import { Schema } from 'effect';

const StatusSchema = Schema.Struct({ status: Schema.Finite });
const FakeSchema = {
  decodeUnknownOption: (_schema: object) => (input: any) => ({ _tag: 'Some', value: input }),
};
const OpaqueSchema = Schema.declare<object>((value) => typeof value === 'object');
const SchemaName = 'StatusSchema';
const UnknownUnion = Schema.Union([StatusSchema, Schema.Unknown]);
const EmptySchema = Schema.Struct({});
const FakeOwnerSchema = { status: Schema.Finite };
const forward = (input: any) => input;

export const fakeDecoder = (input: unknown) => FakeSchema.decodeUnknownOption(StatusSchema)(input);
export const shadowedDecoder = (Schema: typeof FakeSchema, input: unknown) =>
  Schema.decodeUnknownOption(StatusSchema)(input);
export const opaqueDecoder = (input: unknown) => Schema.decodeUnknownOption(OpaqueSchema)(input);
export const escapedRaw = (input: unknown) => ({ parsed: Schema.decodeUnknownOption(StatusSchema)(input), input });
export const wholeUnknown = (input: unknown) => Schema.decodeUnknownOption(Schema.Unknown)(input);
export const schemaStringAlias = (input: unknown) => Schema.decodeUnknownOption(SchemaName)(input);
export const unparsedForward = (input: unknown) => forward(input);
export const escapedClosure = (input: unknown) => () => Schema.decodeUnknownOption(StatusSchema)(input);
export const unknownUnion = (input: unknown) => Schema.decodeUnknownOption(UnknownUnion)(input);
export const emptyOwner = (input: unknown) => Schema.decodeUnknownOption(EmptySchema)(input);
export const fakeOwner = (input: unknown) => Schema.decodeUnknownOption(FakeOwnerSchema)(input);
