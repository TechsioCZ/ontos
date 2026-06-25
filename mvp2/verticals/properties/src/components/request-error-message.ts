export const requestErrorMessage = (error: unknown, fallback: string): string =>
  typeof error === 'object' &&
  error !== null &&
  'cause' in error &&
  typeof error.cause === 'object' &&
  error.cause !== null &&
  'message' in error.cause &&
  typeof error.cause.message === 'string'
    ? error.cause.message
    : fallback;
