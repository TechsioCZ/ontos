import { spawnSync } from 'node:child_process';

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';

// UltraModern validates version and Effect metadata; OntOS also rejects its non-tsrs fallback.
export const resolveTsrsCompiler = (options) => {
  const compiler = resolveEffectTsgoCompiler(options);
  const version = spawnSync(compiler, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, TSRS_CHECKER_ASSIGNMENT: 'go' },
  });
  if (version.error) {
    throw version.error;
  }
  const stamp = version.stdout?.trim();
  if (version.status !== 0 || !stamp?.includes('+effect-tsgo.') || !stamp.includes('(tsrs ')) {
    console.error(
      `[OntOS typecheck] Effect-enabled tsrs is required; refusing fallback ${compiler}: ${stamp ?? version.stderr}. ` +
        'Install the matching native packages, or set TSRS_BINARY to a matching Effect-enabled tsrs artifact. ' +
        'The pinned Effect provider does not bundle a musl tsrs artifact.',
    );
    throw new Error('Effect-enabled tsrs is required; compiler fallback is disabled.');
  }
  console.info(`[OntOS typecheck] ${stamp}\n[OntOS typecheck] compiler=${compiler}`);
  return compiler;
};
