/// <reference types="node" />

// This Node-only build entry sits outside the package's src-only TypeScript project.
// @effect-diagnostics nodeBuiltinImport:off -- Build-time Modern config: Node's connect dev middleware, Rspack resolution and file URLs run outside any Effect runtime, and the effect barrel cannot load under jiti; expires: 2027-03-31.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getBuildConfigEnvironment } from '@modern-js/app-tools-extensions/config';
import { getOrUndefined as getOptionOrUndefined } from 'effect/Option';
import { isSuccess as isResultSuccess } from 'effect/Result';
import { OptionFromUndefinedOr, Trim, check, decodeResult, isMinLength } from 'effect/Schema';

type BuildEnvironmentReader = (name: string) => string | undefined;

const NonEmptyBuildStringSchema = OptionFromUndefinedOr(Trim.pipe(check(isMinLength(1))));

/** Reads a build input from the framework build environment; blank values count as unset. */
const readBuildEnvironmentValue: BuildEnvironmentReader = (name) => {
  const decoded = decodeResult(NonEmptyBuildStringSchema)(getBuildConfigEnvironment(name));
  return isResultSuccess(decoded) ? getOptionOrUndefined(decoded.success) : undefined;
};

interface DevelopmentMiddlewareSetup {
  unshift: (
    middleware: (
      request: { url?: string | undefined },
      response: { end: (body: Buffer) => void; setHeader: (name: string, value: string) => void },
      next: () => void,
    ) => void,
  ) => void;
}

const DEVELOPMENT_CONTRACT_ARTIFACTS: ReadonlySet<string> = new Set([
  '/.well-known/ontos-module-manifest.json',
  '/.well-known/ontos-module-mcp-tools.json',
]);

/** Serves the unit's prepared development module contract and its MCP tool catalog ahead of locale redirects. */
export const createDevelopmentContractMiddleware =
  (moduleUrl: string) =>
  ({ unshift }: DevelopmentMiddlewareSetup) => {
    unshift((request, response, next) => {
      const requestPath = request.url?.split('?', 1)[0];
      if (requestPath === undefined || !DEVELOPMENT_CONTRACT_ARTIFACTS.has(requestPath)) {
        next();
        return;
      }
      const contract = readFileSync(fileURLToPath(new URL(`.dev-public${requestPath}`, moduleUrl)));
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Content-Length', String(contract.byteLength));
      response.end(contract);
    });
  };

/** OntOS data-plane policy and module discovery, composed with the published workspace preset. */
export const createWorkspaceModernConfig = ({
  appId,
  headless = false,
  moduleUrl,
}: {
  appId: string;
  /**
   * An `api-only` topology unit keeps domain code in `src/`, so it points Modern's web entries at an
   * absent directory and builds only its BFF.
   */
  headless?: boolean;
  moduleUrl: string;
}) => ({
  dev: {
    setupMiddlewares: appId === 'shell-super-app' ? [] : [createDevelopmentContractMiddleware(moduleUrl)],
  },
  output: {
    // The native TS-Go checker blocks every first compile on a check of the whole reference graph, which
    // holds a cold dev server past readiness budgets. Builds keep the checker; in `modern dev`,
    // `pnpm typecheck` owns type diagnostics. A CI unit build that has already run its own TS-Go reference
    // build (`ultramodern typecheck --build`, which fails on a transitive type error) sets
    // ULTRAMODERN_DISABLE_BUILD_TS_CHECKER=1 instead of checking the same graph twice.
    disableTsChecker:
      readBuildEnvironmentValue('NODE_ENV') === 'development' ||
      readBuildEnvironmentValue('ULTRAMODERN_DISABLE_BUILD_TS_CHECKER') === '1',
  },
  server: {
    publicDir: ['./.dev-public'],
  },
  source: {
    ...(headless ? { entriesDir: '.api-only-no-web-entry' } : undefined),
    globalVars: {
      ULTRAMODERN_SHELL_ORIGIN: readBuildEnvironmentValue('ULTRAMODERN_MF_DEV_ORIGIN') ?? 'http://localhost:3020',
    },
  },
});
