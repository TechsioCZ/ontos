#!/usr/bin/env node
/* eslint-disable node/no-process-env -- This command materializes explicit local-only defaults. */
import { readFile, rename, writeFile } from 'node:fs/promises';

import { APP_ENV_PATH } from '../packages/core-runtime/src/environment/workspace-environment.ts';
import { localSpiceDbValues } from './local-environment-values.mts';

const original = await readFile(APP_ENV_PATH, 'utf-8');
const lines = original.replace(/\r\n/gu, '\n').split('\n');
const remaining = new Map(
  Object.entries(
    localSpiceDbValues(lines, {
      ...(process.env['LOCAL_SPICEDB_GRPC_PORT']?.trim()
        ? { grpcPort: process.env['LOCAL_SPICEDB_GRPC_PORT']?.trim() }
        : {}),
      ...(process.env['LOCAL_SPICEDB_HTTP_PORT']?.trim()
        ? { httpPort: process.env['LOCAL_SPICEDB_HTTP_PORT']?.trim() }
        : {}),
      ...(process.env['LOCAL_SPICEDB_PRESHARED_KEY']?.trim()
        ? { preSharedKey: process.env['LOCAL_SPICEDB_PRESHARED_KEY']?.trim() }
        : {}),
    }),
  ),
);
const updated = lines.map((line) => {
  const match = /^(?<key>[A-Z][A-Z0-9_]*)=/u.exec(line);
  const key = match?.groups?.['key'];
  if (key === undefined || !remaining.has(key)) {
    return line;
  }
  const value = remaining.get(key);
  remaining.delete(key);
  return `${key}=${value}`;
});

while (updated.at(-1) === '') {
  updated.pop();
}
if (remaining.size > 0) {
  updated.push('', '# Development-only local SpiceDB values.');
  for (const [key, value] of remaining) {
    updated.push(`${key}=${value}`);
  }
}

const temporaryPath = `${APP_ENV_PATH}.tmp-${process.pid}`;
await writeFile(temporaryPath, `${updated.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 });
await rename(temporaryPath, APP_ENV_PATH);
console.log(`Updated the canonical local environment at ${APP_ENV_PATH}`);
