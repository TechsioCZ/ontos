// expect-count: 6
const check = (value: unknown) => [
  value instanceof Error,
  value instanceof LocalDevelopmentInitializationError,
  value instanceof ProviderException,
  value instanceof globalThis.Date,
  value instanceof SDK.APIError,
  value instanceof Alias,
];
