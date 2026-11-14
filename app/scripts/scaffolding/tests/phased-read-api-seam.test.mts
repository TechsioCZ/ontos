import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'effect-rstest';

import { hasCompleteGeneratedModuleApiSeam } from '../../generated-governed-http-boundary.mts';

const appRoot = path.resolve(import.meta.dirname, '../../..');
const marketOwner = 'commerce-market-catalog';
const effectImport = "from 'effect'";
const sources = new Map<string, string>();
const excluded = new Set(['node_modules', 'dist', '.output', '.modern', '.git', 'coverage', '.cache']);
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(appRoot, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name) && !entry.name.startsWith('dist')) {
      collect(file);
    } else if (entry.isFile() && (/\.(?:ts|tsx)$/u.test(entry.name) || entry.name === 'package.json')) {
      sources.set(file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
  }
};
for (const directory of [
  'verticals/commerce-market-catalog',
  'verticals/catalog',
  'packages/catalog-selection-contracts',
]) {
  collect(directory);
}

const cases = [
  {
    action: 'eligible-market-tuples',
    callback: 'handleEligibleMarketTuples',
    forwarded: 'prepareEligibleMarketTuples(input, context)',
    owner: marketOwner,
  },
  {
    action: 'activate-local-override-recovery',
    callback: 'recoverActivateLocalOverride',
    forwarded: 'recoverActivateLocalOverride(input, context)',
    owner: 'catalog',
  },
];

for (const { action, callback, forwarded, owner } of cases) {
  it(`proves the complete current ${owner} API seam with its actual phased ${action} Read`, () => {
    const diagnostics: string[] = [];
    expect(
      hasCompleteGeneratedModuleApiSeam(sources, `verticals/${owner}/shared/api.ts`, owner, diagnostics),
      diagnostics.join('\n'),
    ).toBe(true);
  });

  it(`rejects malformed ${owner} phase records and unproved or mutated callback authority`, () => {
    const file = `verticals/${owner}/src/api/${action}.read.ts`;
    const original = sources.get(file) ?? '';
    expect(original.length).toBeGreaterThan(0);
    for (const invalid of [
      original.replace('load:', 'finish:'),
      original.replace('load:', 'unknownPhase:'),
      original.replace('load:', 'load: unknownCallback, load:'),
      original.replace('load:', '...unknownPhases, load:'),
      original.replace('load:', 'unknownPhase: unknownCallback, load:'),
      original.replace(effectImport, "from './foreign-effect.ts'"),
      original.replace(forwarded, forwarded.replace('context)', 'untrustedContext)')),
      original.replace(forwarded, forwarded.replace(forwarded.slice(0, forwarded.indexOf('(')), 'unboundCallback')),
      `${original}\n${callback} = unknownCallback;\n`,
      `${original}\nconst escaped = ${callback};\n`,
      `${original}\nfunction shadow(Effect) {}\n`,
    ]) {
      expect(invalid).not.toBe(original);
      const modified = new Map<string, string>([...sources, [file, invalid]]);
      const diagnostics: string[] = [];
      expect(hasCompleteGeneratedModuleApiSeam(modified, `verticals/${owner}/shared/api.ts`, owner, diagnostics)).toBe(
        false,
      );
      expect(diagnostics).toContain(`${action}: read`);
    }
  });

  it(`keeps the actual ${owner} native backend registration and mounted root authoritative`, () => {
    const file = `verticals/${owner}/api/index.ts`;
    const original = sources.get(file) ?? '';
    const invalid = original.replace('../vertical.runtime-declaration.ts', '../foreign.runtime-declaration.ts');
    expect(invalid).not.toBe(original);
    const modified = new Map<string, string>([...sources, [file, invalid]]);
    expect(hasCompleteGeneratedModuleApiSeam(modified, `verticals/${owner}/shared/api.ts`, owner)).toBe(false);
  });
}

it('proves only the actual Core search query dependency, not a foreign, unbound, mutated or replaced layer', () => {
  const owner = marketOwner;
  const file = `verticals/${owner}/api/index.ts`;
  const original = sources.get(file) ?? '';
  for (const invalid of [
    original.replace(
      'GovernedReadLayer.provide(marketSearchQueryRuntimeLive)',
      'GovernedReadLayer.provide(unboundSearchRuntimeLive)',
    ),
    original.replace(
      'const productionMarketSearchQueryRuntimeLive = CoreSearchQueryRuntimeLive.pipe(',
      'const productionMarketSearchQueryRuntimeLive = ForeignSearchQueryRuntimeLive.pipe(',
    ),
    original.replace('Layer.provide(CoreSearchProjectionStoreLive)', 'Layer.provide(OtherProjectionStoreLive)'),
    `${original}\nproductionMarketSearchQueryRuntimeLive = replacement;\n`,
    `${original}\nfunction shadow(GovernedReadLayer) {}\n`,
  ]) {
    expect(invalid).not.toBe(original);
    const modified = new Map<string, string>([...sources, [file, invalid]]);
    const diagnostics: string[] = [];
    expect(hasCompleteGeneratedModuleApiSeam(modified, `verticals/${owner}/shared/api.ts`, owner, diagnostics)).toBe(
      false,
    );
  }
});

// A non-Never search-rebuild domain set is rejected by the type checker: the generated problem mapper passes
// domain errors to `absurd`, so `pnpm typecheck` fails before any seam proof runs. Main's seam proof does not
// repeat that check, so the trunk's seam-level assertion for it is gone.
it('requires the current search prepare phase to forward the genuine LIST decision and scope unchanged', () => {
  const file = `verticals/${marketOwner}/src/search/markets.provider.ts`;
  const original = sources.get(file) ?? '';
  for (const invalid of [
    original.replace('{ listAccess: context.listAccess }', '{ listAccess: unrestricted }'),
    original.replace('loadMarkets(context.scope, input,', 'loadMarkets(untrustedScope, input,'),
    original.replace('context: ReadPrepareContext', 'context: unknown'),
    original.replace('prepare: prepareMarkets,', 'prepare: unboundPrepare,'),
    `${original}\nloadMarkets = unboundPrepare;\n`,
    `${original}\nfunction shadow(ReadPrepareContext) {}\n`,
  ]) {
    expect(invalid).not.toBe(original);
    const modified = new Map<string, string>([...sources, [file, invalid]]);
    const diagnostics: string[] = [];
    expect(
      hasCompleteGeneratedModuleApiSeam(modified, `verticals/${marketOwner}/shared/api.ts`, marketOwner, diagnostics),
    ).toBe(false);
    expect(diagnostics).toContain('markets: read');
  }
});
