#!/usr/bin/env node
import { CodeSmith } from '@modern-js/codesmith';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CliOptions {
  readonly action?: string;
  readonly actionKey?: string;
  readonly idempotency?: string;
  readonly moduleStateAccess?: string;
  readonly path?: string;
  readonly permission?: string;
  readonly resourceId?: string;
  readonly resourceType?: string;
  readonly title?: string;
  readonly vertical?: string;
}

const usage = `Usage:
  pnpm scaffold:action -- --vertical ticketing --action create-ticket

Options:
  --vertical <slug>              Existing installed microvertical/module key, for example "ticketing".
  --action <slug>                Action slug, for example "create-ticket".
  --action-key <key>             Optional public action key. Defaults to <vertical>.<camelAction>.
  --path <path>                  Optional POST route. Defaults to /<vertical>/actions/<action>.
  --idempotency <mode>           "optional" or "required". Defaults to optional.
  --module-state-access <kind>   "mutate", "read", or "load". Defaults to mutate.
  --permission <permission>      SpiceDB permission. Defaults to create.
  --resource-type <type>         SpiceDB resource object type. Defaults to resource_type.
  --resource-id <id>             SpiceDB resource object id. Defaults to the action key.
  --title <text>                 Optional human-readable title used in generated messages.
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
      case '--action-key':
      case '--idempotency':
      case '--module-state-access':
      case '--path':
      case '--permission':
      case '--resource-id':
      case '--resource-type':
      case '--title':
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
    action: options.action,
    actionKey: options['action-key'],
    idempotency: options.idempotency,
    moduleStateAccess: options['module-state-access'],
    path: options.path,
    permission: options.permission,
    resourceId: options['resource-id'],
    resourceType: options['resource-type'],
    title: options.title,
    vertical: options.vertical,
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.vertical === undefined || options.action === undefined) {
    throw new Error('Both --vertical and --action are required.');
  }

  const smith = new CodeSmith({
    namespace: 'ontos',
    time: true,
  });

  await smith.forge({
    pwd: workspaceRoot,
    tasks: [
      {
        generator: 'file:scripts/codesmith/generators/action',
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
