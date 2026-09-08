import { builtinModules } from 'node:module';
import path from 'node:path';

const nodeBuiltinRequests = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

interface ExternalRequest {
  dependencyType?: string;
  request?: string;
}
type ExternalResult = [
  error?: Error | undefined,
  result?: string | string[],
  type?: 'module-import',
];

export const resolveCloudflareExternal = (
  { dependencyType, request }: ExternalRequest,
  includeNodeBuiltins = true,
): ExternalResult => {
  if (request === undefined) {
    return [];
  }
  const isNodeBuiltin = includeNodeBuiltins && nodeBuiltinRequests.has(request);
  if (request !== 'cloudflare:sockets' && !isNodeBuiltin) {
    return [];
  }
  const specifier = isNodeBuiltin && !request.startsWith('node:') ? `node:${request}` : request;
  const nativeImport =
    dependencyType?.startsWith('commonjs') === true ? [specifier, 'default'] : specifier;
  return [undefined, nativeImport, 'module-import'];
};

export const createZephyrRspackPlugin = <Configuration>(options: {
  configure: () => Configuration;
  readToken: () => string | undefined;
}) => ({
  name: 'ultramodern-zephyr-rspack-plugin',
  pre: ['@modern-js/plugin-module-federation-config'],
  setup(api: { modifyRspackConfig: (configuration: Configuration) => void }) {
    // Only authoritative CI deployments upload artifacts. Ordinary builds need
    // no Zephyr account or network access; deployment upload failures stay fatal.
    if (options.readToken() === undefined) {
      return;
    }
    api.modifyRspackConfig(options.configure());
  },
});

export const createCloudflareWorkerSecurity = () => ({
  contentSecurityPolicy: {
    directives: {
      'base-uri': ["'self'"],
      'connect-src': ["'self'", 'https:', 'http:', 'wss:', 'ws:'],
      'default-src': ["'self'"],
      'font-src': ["'self'", 'data:', 'https:', 'http:'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
      'manifest-src': ["'self'", 'https:', 'http:'],
      'object-src': ["'none'"],
      'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https:', 'http:', 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'", 'https:', 'http:'],
      'worker-src': ["'self'", 'blob:'],
    },
    mode: 'report-only' as const,
    reason:
      'Report-only by default so Cloudflare Module Federation SSR can prove remote script, style, and connect compatibility before enforcement.',
  },
  enabled: true,
  headers: {
    contentTypeOptions: 'nosniff' as const,
    permissionsPolicy: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    referrerPolicy: 'strict-origin-when-cross-origin' as const,
  },
  noindex: {
    localhost: true,
    previewHostnames: [],
    workersDev: true,
  },
});

interface ReplacementResource {
  context: string;
  request: string;
}

const retainWorkerLoader = (resource: ReplacementResource) => {
  resource.request = resource.request.replace(
    /(?<separator>[?&])retain=[^&]*/u,
    '$<separator>retain=true',
  );
};

const markWorkerApiSource = (resource: ReplacementResource, sourceDirectory: string) => {
  const [requestPath] = resource.request.split('?', 1);
  if (
    requestPath !== undefined &&
    path.resolve(resource.context, requestPath).startsWith(sourceDirectory) &&
    !resource.request.includes('modern-bff-runtime-source')
  ) {
    resource.request = `${resource.request}?modern-bff-runtime-source`;
  }
};

export const createWorkerSsrPlugins = <DefinitionPlugin, ReplacementPlugin>(
  rspack: {
    DefinePlugin: new (definitions: Record<string, string>) => DefinitionPlugin;
    NormalModuleReplacementPlugin: new (
      pattern: RegExp,
      replace: (resource: ReplacementResource) => void,
    ) => ReplacementPlugin;
  },
  sourceDirectory: string,
) => [
  new rspack.DefinePlugin({ 'globalThis.FinalizationRegistry': 'undefined' }),
  new rspack.NormalModuleReplacementPlugin(/[?&]loaderId=/u, retainWorkerLoader),
  new rspack.NormalModuleReplacementPlugin(/^\.\.?[/\\]/u, (resource) => {
    markWorkerApiSource(resource, sourceDirectory);
  }),
];
