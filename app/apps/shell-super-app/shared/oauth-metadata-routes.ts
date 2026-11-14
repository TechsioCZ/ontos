/** One route table for Node middleware and the Cloudflare BFF pre-handler. */
const OAUTH_ISSUER_PATH = '/shell-super-app-api/oauth';
const METADATA_DOCUMENTS = ['oauth-authorization-server', 'openid-configuration'] as const;

export const OAUTH_METADATA_ROUTES: ReadonlyMap<string, string> = new Map(
  METADATA_DOCUMENTS.flatMap((document) => {
    const target = `${OAUTH_ISSUER_PATH}/.well-known/${document}`;
    return [
      [`/.well-known/${document}`, target],
      [`/.well-known/${document}${OAUTH_ISSUER_PATH}`, target],
    ];
  }),
);

export const oauthMetadataTarget = (pathname: string): string | undefined => OAUTH_METADATA_ROUTES.get(pathname);
