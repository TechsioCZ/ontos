import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { appRoot, oxlintEntryPoint } from './oxlint.mts';

// Oxlint prints the JS plugin registry in platform-specific hash order. Names and specifiers matter, not registry order.
const plugin = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String, specifier: Schema.String })]);
const config = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ jsPlugins: Schema.Array(plugin) }), [
    Schema.Record(Schema.String, Schema.Json),
  ]),
);
const policy = (json: string) => {
  const { jsPlugins, ...fields } = Schema.decodeUnknownSync(config)(json);
  return { ...fields, jsPlugins: jsPlugins.map((entry) => JSON.stringify(entry)).toSorted() };
};

it('retains the complete resolved lint policy including ordered override scopes', () => {
  const output = execFileSync(process.execPath, [oxlintEntryPoint, '--print-config'], {
    cwd: appRoot,
    encoding: 'utf-8',
  });
  const stylesheet = '@techsio/ui-kit/styles.css';
  const resolved = createRequire(path.join(appRoot, 'apps/shell-super-app/package.json')).resolve(stylesheet);
  // Only this independently resolved package export varies by machine; a different asset still fails equality.
  const portable = output.replaceAll(JSON.stringify(resolved), JSON.stringify(stylesheet));
  const expected = readFileSync(path.join(appRoot, 'quality-audit/effective-oxlint-policy.json'), 'utf-8');
  expect(policy(portable)).toEqual(policy(expected));
});
