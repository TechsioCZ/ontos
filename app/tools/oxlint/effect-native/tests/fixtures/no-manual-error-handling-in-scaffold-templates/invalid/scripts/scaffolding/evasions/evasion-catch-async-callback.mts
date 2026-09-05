/** Promise-style classifier with an `async` callback: `async ` precedes the parameter list. */
export const renderRetryingLoader = (): string => `
export const load = () =>
  client.read().catch(async (error) => {
    if (await shouldRetry(error)) {
      return retry();
    }
    return null;
  });
`;
