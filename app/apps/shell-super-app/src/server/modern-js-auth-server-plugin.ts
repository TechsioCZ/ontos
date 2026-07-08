// @effect-diagnostics asyncFunction:off
import { handleShellAuthNodeRequest, handleShellOperationContextRequest } from './auth-handler';

const authPath = '/shell-super-app-api/auth/*';
const operationContextPath = '/shell-super-app-api/operation-context';
type NodeAuthRequest = Parameters<typeof handleShellAuthNodeRequest>[0];
type NodeAuthResponse = Parameters<typeof handleShellAuthNodeRequest>[1];

interface MiddlewareContext {
  env: {
    node: {
      req: NodeAuthRequest;
      res: NodeAuthResponse;
    };
  };
  finalized?: boolean;
  req: {
    raw: Request;
  };
  res: Response;
}

interface ServerPluginApi {
  getServerContext: () => {
    middlewares: {
      before?: string[];
      handler: (context: MiddlewareContext) => void | Promise<void>;
      method?: 'all';
      name: string;
      order?: 'pre';
      path?: string;
    }[];
  };
  onPrepare: (handler: () => void) => void;
}

interface ServerPlugin {
  name: string;
  setup: (api: ServerPluginApi) => void;
}

const authServerPlugin = (): ServerPlugin => ({
  name: 'modern-js-shell-super-app-auth-server-plugin',
  setup(api) {
    api.onPrepare(() => {
      const serverContext = api.getServerContext();

      serverContext.middlewares.push({
        before: ['effect-api-handler', 'custom-server-middleware', 'render'],
        handler: async (context) => {
          await handleShellAuthNodeRequest(context.env.node.req, context.env.node.res);
          context.finalized = true;
        },
        method: 'all',
        name: 'better-auth-handler',
        order: 'pre',
        path: authPath,
      });
      serverContext.middlewares.push({
        before: ['effect-api-handler', 'custom-server-middleware', 'render'],
        handler: async (context) => {
          context.res = await handleShellOperationContextRequest(context.req.raw);
          context.finalized = true;
        },
        method: 'all',
        name: 'shell-operation-context-handler',
        order: 'pre',
        path: operationContextPath,
      });
    });
  },
});

export default authServerPlugin;
