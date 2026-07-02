import { handleShellAuthNodeRequest } from './auth-handler';

const authPath = '/shell-super-app-api/auth/*';
type NodeAuthRequest = Parameters<typeof handleShellAuthNodeRequest>[0];
type NodeAuthResponse = Parameters<typeof handleShellAuthNodeRequest>[1];

type MiddlewareContext = {
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
};

type ServerPluginApi = {
  getServerContext: () => {
    middlewares: Array<{
      before?: string[];
      handler: (context: MiddlewareContext) => void | Promise<void>;
      method?: 'all';
      name: string;
      order?: 'pre';
      path?: string;
    }>;
  };
  onPrepare: (handler: () => void) => void;
};

type ServerPlugin = {
  name: string;
  setup: (api: ServerPluginApi) => void;
};

const authServerPlugin = (): ServerPlugin => ({
  name: 'modern-js-shell-super-app-auth-server-plugin',
  setup(api) {
    api.onPrepare(() => {
      const serverContext = api.getServerContext();

      serverContext.middlewares.push({
        before: ['effect-api-handler', 'custom-server-middleware', 'render'],
        handler: (context) =>
          handleShellAuthNodeRequest(context.env.node.req, context.env.node.res).then(() => {
            context.res;
            context.finalized = true;
          }),
        method: 'all',
        name: 'better-auth-handler',
        order: 'pre',
        path: authPath,
      });
    });
  },
});

export default authServerPlugin;
