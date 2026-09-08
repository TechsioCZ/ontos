export const makeCommandAssertionFetch = (
  ownerResponse: (request: Request) => Response,
  tokenPrefix: string
) => {
  const requests: Request[] = [];
  let assertions = 0;
  const fakeFetch: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).hostname === 'shell.example') {
      assertions += 1;
      return Promise.resolve(
        Response.json({
          expiresAt: 2_000_000_000,
          token: `${tokenPrefix}-${assertions}`,
        })
      );
    }
    return Promise.resolve(ownerResponse(request));
  };
  return { assertions: () => assertions, fakeFetch, requests };
};
