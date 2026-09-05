// `scripts/**` is owned by effect-native/no-throw-in-scripts and is outside this rule's scope.
export const bootstrap = (): string => {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) {
    throw new Error('DATABASE_URL is required');
  }
  return url;
};
