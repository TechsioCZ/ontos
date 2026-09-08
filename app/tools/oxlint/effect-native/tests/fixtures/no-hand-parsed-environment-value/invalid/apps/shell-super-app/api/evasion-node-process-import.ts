// expect-count: 5
// Evasion: the ambient environment reached through an ESM import of `node:process` instead of the
// implicit global. Sibling rules in this plugin (no-throw-in-configuration-parser,
// no-ad-hoc-argv-in-scripts, no-console-in-scripts, no-process-exit-outside-script-entry) all track
// these bindings; this rule's `isUnshadowedGlobal` treats the import as a *shadow* and goes silent.
import process from 'node:process';
import * as nodeProcess from 'node:process';
import { env as processEnvironment } from 'node:process';

export const port = Number(process.env.PORT ?? '3020');
export const debug = process.env.DEBUG === 'true';
export const databaseUrl = new URL(nodeProcess.env.DATABASE_URL ?? '');
export const level = nodeProcess.env['LOG_LEVEL']?.trim();
export const isProduction = processEnvironment.NODE_ENV === 'production';
