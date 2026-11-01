import { Context } from 'effect';

import type { ShellGovernedReadRegistrationSet } from './shell-governed-reads.ts';

export class ShellGovernedReadDefinitions extends Context.Service<
  ShellGovernedReadDefinitions,
  ShellGovernedReadRegistrationSet
>()('@app/shell-super-app/api/modules/shell-governed-read-definitions/ShellGovernedReadDefinitions') {}
