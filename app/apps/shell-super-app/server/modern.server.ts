// @effect-diagnostics asyncFunction:off -- Modern.js server middleware (Hono) is a Promise boundary: these adapters load the BFF module and call its Promise entry points. expires: 2027-03-31.
import {
  oauthPageSecurityHeaders,
  preloadModule,
  serveRootMetadataAlias,
  serveRootRoute,
  viaModule,
} from './root-routes.ts';

// Node: the BFF module loads when the server starts (dist/ is complete then), not at the first root request. Loaded at the
// first request it was resolved from disk at that moment, so a request during an in-place dist/ rebuild answered 500.
const shellBff = preloadModule(async () => await import('../api/index.ts'));

export default {
  middlewares: [
    {
      handler: serveRootMetadataAlias(
        viaModule(shellBff, async (bff, request) => await bff.handleOAuthMetadata(request)),
      ),
      name: 'ontos-oauth-root-metadata',
      order: 'pre',
    },
    {
      handler: serveRootRoute(viaModule(shellBff, async (bff, request) => await bff.handleRootRoute(request))),
      name: 'ontos-bff-root-routes',
      order: 'pre',
    },
    { handler: oauthPageSecurityHeaders, name: 'ontos-oauth-page-headers', order: 'pre' },
  ],
};
