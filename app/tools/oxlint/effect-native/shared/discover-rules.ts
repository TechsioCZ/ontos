import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Rule } from '@oxlint/plugins';

const rulesDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

/** Rule file names (without extension) present in `rules/`, sorted for deterministic registration. */
export function listRuleNames(): readonly string[] {
  return readdirSync(rulesDirectory)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
    .map((entry) => entry.slice(0, -'.ts'.length))
    .sort();
}

/** Import selected rules; isolated fixture runs need not load unrelated modules under repair. */
export async function discoverRules(
  names: readonly string[] = listRuleNames(),
): Promise<Record<string, Rule>> {
  const available = new Set(listRuleNames());
  const rules: Record<string, Rule> = {};
  for (const name of names) {
    if (!available.has(name)) throw new Error(`Unknown fixture rule: ${name}`);
    const module: { rule?: Rule; default?: Rule } = await import(
      pathToFileURL(join(rulesDirectory, `${name}.ts`)).href
    );
    const rule = module.rule ?? module.default;
    if (rule === undefined) {
      throw new Error(`rules/${name}.ts must export \`rule\` (created with defineRule).`);
    }
    rules[name] = rule;
  }
  return rules;
}
