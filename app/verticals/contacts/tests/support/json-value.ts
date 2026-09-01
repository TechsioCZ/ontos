export type JsonScalar = boolean | null | number | string;
export type JsonValue = JsonObject | JsonScalar | readonly JsonValue[];
export type JsonObject = Readonly<Record<string, JsonValue>>;

const isRuntimeObject = <Value>(value: Value): value is Value & object =>
  value !== null && Object(value) === value;

export const parseJsonValue = <Input>(input: Input): JsonValue => {
  if (input === null) {
    return null;
  }
  if (input === String(input)) {
    return String(input);
  }
  if (input === Number(input)) {
    return Number(input);
  }
  if (input === Boolean(input)) {
    return Boolean(input);
  }
  if (!isRuntimeObject(input)) {
    throw new TypeError('Value is not JSON-compatible');
  }
  if (Array.isArray(input)) {
    return input.map(parseJsonValue);
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, parseJsonValue(value)]),
  );
};

export const parseJsonObject = <Input>(input: Input): JsonObject => {
  const value = parseJsonValue(input);
  if (!isRuntimeObject(value) || Array.isArray(value)) {
    throw new TypeError('Value is not a JSON object');
  }
  return value;
};
