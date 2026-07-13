#!/usr/bin/env node
import { CodeSmith } from '@modern-js/codesmith';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dirname, '..');

interface CliOptions {
  readonly policy?: string;
  readonly scope?: string;
  readonly vertical?: string;
}

const usage = `Usage:
  pnpm scaffold:policy -- --scope global --policy require-authenticated-principal
  pnpm scaffold:policy -- --scope microvertical --vertical ticketing --policy target-resource-present

Options:
  --scope <scope>      "global" or "microvertical".
  --policy <slug>     Policy slug, for example "target-resource-present".
  --vertical <slug>   Required for microvertical policies, for example "ticketing".
`;

const readOptionValue = (args: readonly string[], index: number, flag: string) => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
};

const parseArgs = (args: readonly string[]): CliOptions => {
  const options: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(usage);
      process.exit(0);
    }

    switch (arg) {
      case '--policy':
      case '--scope':
      case '--vertical': {
        const value = readOptionValue(args, index, arg);
        options[arg.slice(2)] = value;
        index += 1;
        break;
      }
      default: {
        throw new Error(`Unknown option: ${arg}`);
      }
    }
  }

  return {
    policy: options.policy,
    scope: options.scope,
    vertical: options.vertical,
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.scope === undefined || options.policy === undefined) {
    throw new Error('--scope and --policy are required.');
  }

  if (options.scope === 'global' && options.vertical !== undefined) {
    throw new Error('--vertical is only supported for microvertical policy generation.');
  }

  if (options.scope === 'microvertical' && options.vertical === undefined) {
    throw new Error('--vertical is required for microvertical policy generation.');
  }

  const smith = new CodeSmith({
    namespace: 'ontos',
    time: true,
  });

  await smith.forge({
    pwd: workspaceRoot,
    tasks: [
      {
        config: options,
        generator: 'file:scripts/codesmith/generators/policy',
      },
    ],
  });
};

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error('');
  console.error(usage);
  process.exit(1);
}
