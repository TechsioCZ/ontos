// Support module for `local-schema-namespace.ts`: a hand-rolled, non-Effect `Schema` object.
export const Json = 'json';
export const Schema = {
  Json,
  Record: (_key: string, _value: string) => 'record',
  String: 'string',
  decodeUnknownSync: (_schema: string) => (value: unknown) => value,
};
