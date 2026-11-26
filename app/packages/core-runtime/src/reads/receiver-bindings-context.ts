import { Context } from 'effect';

import type { CoreReadReceiverBindingRegistry } from './receiver-bindings.ts';

/** The receiving host supplies one captured registry to the read runtime. */
export class CoreReadReceiverBindings extends Context.Service<
  CoreReadReceiverBindings,
  CoreReadReceiverBindingRegistry
>()('@app/core-runtime/reads/receiver-bindings-context/CoreReadReceiverBindings') {}
