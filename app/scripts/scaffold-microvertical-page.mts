#!/usr/bin/env node
import { CodeSmith } from '@modern-js/codesmith';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CliOptions {
  readonly csDescription?: string;
  readonly description?: string;
  readonly page?: string;
  readonly routePath?: string;
  readonly vertical?: string;
}

const usage = `Usage:
  pnpm scaffold:microvertical-page -- --vertical ticketing --page support-queue

Options:
  --vertical <slug>        Existing installed microvertical/module key, for example "ticketing".
  --page <slug>            Page slug, for example "support-queue".
  --description <text>     English page description/body copy.
  --cs-description <text>  Optional Czech description. Defaults to --description.
  --route-path <path>      Optional shell route path. Defaults to /<vertical>/<page>.
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
      case '--cs-description':
      case '--description':
      case '--page':
      case '--route-path':
      case '--vertical': {
        const value = readOptionValue(args, index, arg);
        options[arg.slice(2)] = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    csDescription: options['cs-description'],
    description: options['description'],
    page: options['page'],
    routePath: options['route-path'],
    vertical: options['vertical'],
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.vertical === undefined || options.page === undefined) {
    throw new Error('Both --vertical and --page are required.');
  }

  const smith = new CodeSmith({
    namespace: 'ontos',
    time: true,
  });

  await smith.forge({
    pwd: workspaceRoot,
    tasks: [
      {
        generator: 'file:scripts/codesmith/generators/microvertical-page',
        config: options,
      },
    ],
  });
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error('');
  console.error(usage);
  process.exit(1);
});
