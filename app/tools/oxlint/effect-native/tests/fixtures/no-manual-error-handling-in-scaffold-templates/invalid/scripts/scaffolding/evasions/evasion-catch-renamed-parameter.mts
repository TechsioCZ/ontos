/** Promise-style classifier whose callback parameter is named `err` rather than `error`. */
export const renderLoader = (): string => `
export const load = () =>
  client.read().catch((err) => {
    if (isUnavailable(err)) {
      return fallback();
    }
    return null;
  });
`;
