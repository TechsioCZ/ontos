#!/usr/bin/env node
import { CodeSmith } from '@modern-js/codesmith';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dirname, '..');

interface CliOptions {
  readonly action?: string;
  readonly topic?: string;
  readonly vertical?: string;
}

const usage = `Usage:
  pnpm scaffold:outbox-message -- --vertical ticketing --action create-ticket --topic ticketing.createTicket.created

Options:
  --vertical <slug>  Existing installed microvertical/module key, for example "ticketing".
  --action <slug>    Existing action slug, for example "create-ticket".
  --topic <topic>    Required outbox topic string, for example "ticketing.createTicket.created".
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
      case '--action':
      case '--topic':
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
    action: options.action,
    topic: options.topic,
    vertical: options.vertical,
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (
    options.vertical === undefined ||
    options.action === undefined ||
    options.topic === undefined
  ) {
    throw new Error('--vertical, --action, and --topic are required.');
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
        generator: 'file:scripts/codesmith/generators/outbox-message',
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
