// D tier: "line-preserving `.env` rewriting where comments and ordering must survive". This rule
// never inspects `.env` file *contents*, only values read out of an environment bag.
import { readFileSync } from 'node:fs';

export const rewrite = (envPath: string, updates: ReadonlyMap<string, string>): string => {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) return line;
      const separator = line.indexOf('=');
      if (separator < 0) return line;
      const key = line.slice(0, separator).trim();
      const replacement = updates.get(key);
      return replacement === undefined ? line : `${key}=${replacement}`;
    })
    .join('\n');
};
