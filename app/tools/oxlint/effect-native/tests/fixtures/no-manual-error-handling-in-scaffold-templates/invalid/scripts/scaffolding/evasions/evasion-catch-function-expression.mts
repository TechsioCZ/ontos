/** Promise-style classifier written as a function expression rather than an arrow. */
export const renderLegacyLoader = (): string => `
export const load = () =>
  client.read().catch(function (error) {
    if (error.status === 503) {
      return fallback();
    }
    return null;
  });
`;
