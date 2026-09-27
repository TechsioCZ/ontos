import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const lintConfig = nodePath.join(appRoot, 'oxlint.config.ts');
// SonarJS rejects files outside the lint root, so stage in the ignored in-repo scratch directory.
const scratch = nodePath.join(appRoot, '.scratch');

// Property keys that name domain vocabulary must not be read as function names.
it('accepts Match.tags and discriminator keys that mirror domain vocabulary', () => {
  mkdirSync(scratch, { recursive: true });
  withTemporaryWorkspace((directory) => {
    const source = nodePath.join(directory, 'handlers.ts');
    writeFileSync(
      source,
      [
        "import { Match } from 'effect';",
        '',
        "type Event = { readonly _tag: 'OrderPlaced' } | { readonly _tag: 'OrderShipped' };",
        "type Row = { readonly kind: 'order_placed' } | { readonly kind: 'order_shipped' };",
        '',
        'export const describeEvent = Match.type<Event>().pipe(',
        '  Match.tags({',
        "    OrderPlaced: () => 'placed',",
        "    OrderShipped: () => 'shipped',",
        '  }),',
        '  Match.exhaustive,',
        ');',
        '',
        "export const describeRow = Match.type<Row>().pipe(Match.discriminatorsExhaustive('kind')({",
        "  order_placed: () => 'placed',",
        "  order_shipped: () => 'shipped',",
        '}));',
        '',
        '// A sibling SonarJS rule proves the plugin ran on this file.',
        'export const duplicated = (flag: boolean) => (flag ? describeEvent : describeEvent);',
        '',
      ].join('\n'),
    );

    const run = runOxlint(lintConfig, [source], appRoot);
    const sonarCodes = run.diagnostics.map(({ code }) => code).filter((code) => code.startsWith('sonarjs('));

    expect(sonarCodes, 'the SonarJS plugin must run on the fixture').toContain('sonarjs(no-all-duplicated-branches)');
    expect(sonarCodes, 'domain-vocabulary keys are not function names').not.toContain('sonarjs(function-name)');
  }, scratch);
});
