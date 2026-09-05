#!/usr/bin/env node
import { Schema } from 'effect';

declare global {
  interface OntosGlobals {
    readonly bootedAt: Date;
  }
}

namespace Legacy {
  export const enum Kind {
    Bootstrap = 'bootstrap',
  }
  export const kind: Kind = Kind.Bootstrap;
}

const path = await import('node:path');

export const BootSchema = Schema.Struct({
  bootedAt: Schema.DateTimeUtc,
  kind: Schema.String,
});

export default { legacy: Legacy.kind, sep: path.sep };
