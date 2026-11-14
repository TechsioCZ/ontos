import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { resolveEffectTsgoCompiler } from '@modern-js/app-tools-extensions/config';

const inspectCompiler = (options) => {
  const compiler = resolveEffectTsgoCompiler(options);
  const version = spawnSync(compiler, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, TSRS_CHECKER_ASSIGNMENT: 'go' },
  });
  if (version.error) {
    throw version.error;
  }
  const stamp = version.stdout?.trim();
  if (version.status !== 0 || !stamp) {
    throw new Error(`Cannot inspect compiler ${compiler}: ${version.stderr ?? `exit status ${version.status}`}`);
  }
  return { compiler, stamp };
};

const isEffectTsrs = ({ stamp }) => stamp.includes('+effect-tsgo.') && stamp.includes('(tsrs ');

const requireEffectTsrs = (selected) => {
  if (!isEffectTsrs(selected)) {
    throw new Error(
      `[OntOS typecheck] Effect-enabled tsrs is required; refusing fallback ${selected.compiler}: ${selected.stamp}. ` +
        'Install matching native packages, or set TSRS_BINARY to a matching Effect-enabled tsrs artifact.',
    );
  }
};

// UltraModern validates version and Effect metadata; the gate never accepts its non-tsrs fallback.
export const resolveTsrsCompiler = (options) => {
  const selected = inspectCompiler(options);
  requireEffectTsrs(selected);
  const { compiler, stamp } = selected;
  console.info(`[OntOS typecheck] ${stamp}\n[OntOS typecheck] compiler=${compiler}`);
  return compiler;
};

const reportedEmitFallbacks = new Set();

// Federation alone may use the existing musl backend, and only after checking its actual emit config.
export const resolveDeclarationCompiler = (options) => {
  const configUrl = new URL('./tsconfig.mf-types.json', options.from);
  const config = JSON.parse(readFileSync(configUrl, 'utf8'));
  if (config.compilerOptions?.noCheck !== true) {
    throw new Error(`Declaration-only compiler selection requires noCheck: true in ${configUrl.href}`);
  }
  const selected = inspectCompiler(options);
  if (isEffectTsrs(selected)) {
    return selected.compiler;
  }
  const manifest = createRequire(options.from).resolve('tsrs/package.json');
  const { getPlatformPackageName } = createRequire(manifest)(join(dirname(manifest), 'lib/platform.js'));
  const platform = getPlatformPackageName();
  if (!platform.startsWith('@tsrs/linux-') || !platform.endsWith('-musl')) {
    requireEffectTsrs(selected);
  }
  const key = `${platform}:${selected.compiler}`;
  if (!reportedEmitFallbacks.has(key)) {
    console.warn(
      `[OntOS declaration emit] WARNING platform=${platform} compiler=${selected.compiler} ` +
        `version=${selected.stamp}; no Effect-enabled tsrs artifact; using existing Effect-Go with noCheck=true.`,
    );
    reportedEmitFallbacks.add(key);
  }
  return selected.compiler;
};
