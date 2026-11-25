#!/usr/bin/env node
/** Four GET-only acceptance checks. Importing this module reads no key and performs no network I/O. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Redacted, Schema } from 'effect';
import { GatewayAuthenticationRequiredProblemSchema } from '@app/shared-contracts';
import {
  SymmyDemoOrderNotFoundProblemSchema, SymmyDemoOrdersResponseSchema,
} from '../../apps/shell-super-app/api/symmy/demo-orders-contract.ts';

/** Symmy is served by the shared stage Shell, not the AKROS storefront or the N1 application. */
export const AKROS_SYMMY_STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
const prefix = '/api/symmy/v1';
const maxResponseBytes = 1_000_000;
const CheckSchema = Schema.Literals([
  'configuration', 'orders-unauthenticated', 'catalog-revision-unauthenticated', 'missing-order', 'orders-list',
]);
type Check = typeof CheckSchema.Type;
export class SymmyNegativeProofFailure extends Schema.TaggedError<SymmyNegativeProofFailure>()(
  'SymmyNegativeProofFailure',
  {
    check: CheckSchema,
    reason: Schema.Literals([
      'invalid_arguments', 'wrong_origin', 'key_file_unreadable', 'invalid_key', 'invalid_selector',
      'network_failed', 'redirect_refused', 'unexpected_status', 'response_invalid', 'orders_empty',
    ]),
    status: Schema.optionalKey(Schema.Int),
  },
) {}

export interface SymmyNegativeProofConfig {
  readonly origin: string;
  readonly apiKey: Redacted.Redacted<string>;
}
export interface SymmyNegativeProofArguments {
  readonly origin: string;
  readonly keyFile: string;
}
const fail = (
  check: Check,
  reason: typeof SymmyNegativeProofFailure.prototype.reason,
  status?: number,
): never => {
  throw new SymmyNegativeProofFailure(status === undefined ? { check, reason } : { check, reason, status });
};

export const checkedNegativeProofOrigin = (origin: string): string => {
  // Exact comparison also refuses credentials, alternate hosts, paths, ports, queries and fragments.
  if (origin !== AKROS_SYMMY_STAGE_ORIGIN) return fail('configuration', 'wrong_origin');
  return origin;
};

/** Explicit --run plus origin and a file path; no key value is accepted on argv or from an environment default. */
export const parseSymmyNegativeProofArguments = (argv: readonly string[]): SymmyNegativeProofArguments => {
  if (argv.length !== 5 || argv[0] !== '--run' || argv[1] !== '--origin' || argv[3] !== '--key-file') {
    return fail('configuration', 'invalid_arguments');
  }
  const origin = argv[2];
  const keyFile = argv[4];
  if (origin === undefined || keyFile === undefined || keyFile.trim().length === 0) {
    return fail('configuration', 'invalid_arguments');
  }
  return { origin: checkedNegativeProofOrigin(origin), keyFile };
};

/** Called only after explicit run arguments have been validated. File contents and I/O errors never reach output. */
export const loadSymmyNegativeProofConfig = async (
  args: SymmyNegativeProofArguments,
  readKeyFile: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<SymmyNegativeProofConfig> => {
  const origin = checkedNegativeProofOrigin(args.origin);
  let key: string;
  try {
    key = (await readKeyFile(args.keyFile)).trim();
  } catch {
    return fail('configuration', 'key_file_unreadable');
  }
  if (key.length === 0 || key.length > 4096 || /[\u0000-\u0020\u007f]/u.test(key)) {
    return fail('configuration', 'invalid_key');
  }
  return { origin, apiKey: Redacted.make(key) };
};

const readBoundedJson = async (response: Response, check: Check): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return fail(check, 'response_invalid', response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        return fail(check, 'response_invalid', response.status);
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return decoded;
  } catch {
    return fail(check, 'response_invalid', response.status);
  } finally {
    reader.releaseLock();
  }
};

/** Never places orders or calls any write endpoint. Output contains fixed check names and numeric statuses only. */
export const runSymmyNegativeProof = async (
  config: SymmyNegativeProofConfig,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly newOrderId?: () => string;
    readonly writeLine?: (line: string) => void;
  } = {},
): Promise<void> => {
  const origin = checkedNegativeProofOrigin(config.origin);
  const fetch = options.fetch ?? globalThis.fetch;
  const writeLine = options.writeLine ?? (() => {});
  const missingId = (options.newOrderId ?? randomUUID)();
  if (!Schema.is(Schema.String.check(Schema.isUUID()))(missingId)) {
    return fail('configuration', 'invalid_selector');
  }
  const request = async (check: Check, path: string, authenticated: boolean, expectedStatus: number) => {
    let response: Response;
    try {
      response = await fetch(`${origin}${prefix}${path}`, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(15_000),
        headers: authenticated
          ? { accept: 'application/json', 'x-api-key': Redacted.value(config.apiKey) }
          : { accept: 'application/json' },
      });
    } catch {
      return fail(check, 'network_failed');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return fail(check, 'redirect_refused', response.status);
    }
    if (response.status !== expectedStatus) {
      await response.body?.cancel();
      return fail(check, 'unexpected_status', response.status);
    }
    return response;
  };
  for (const { check, path, authenticated, status } of [
    { check: 'orders-unauthenticated', path: '/orders', authenticated: false, status: 401 },
    { check: 'catalog-revision-unauthenticated', path: '/catalog/revision', authenticated: false, status: 401 },
    { check: 'missing-order', path: `/orders/${missingId}`, authenticated: true, status: 404 },
  ] satisfies readonly { readonly check: Check; readonly path: string; readonly authenticated: boolean; readonly status: number }[]) {
    const response = await request(check, path, authenticated, status);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (mime !== 'application/problem+json' ||
        (!authenticated && response.headers.get('www-authenticate') !== 'ApiKey realm="ontos-gateway"')) {
      await response.body?.cancel();
      return fail(check, 'response_invalid', response.status);
    }
    const problem = await readBoundedJson(response, check);
    const expectedProblem = check === 'missing-order' ? SymmyDemoOrderNotFoundProblemSchema : GatewayAuthenticationRequiredProblemSchema;
    if (!Schema.is(expectedProblem)(problem)) {
      return fail(check, 'response_invalid', response.status);
    }
    writeLine(`PASS ${check} status=${String(response.status)}`);
  }
  const response = await request('orders-list', '/orders?limit=1&offset=0', true, 200);
  const raw = await readBoundedJson(response, 'orders-list');
  let page: typeof SymmyDemoOrdersResponseSchema.Type;
  try {
    page = Schema.decodeUnknownSync(SymmyDemoOrdersResponseSchema)(raw);
  } catch {
    return fail('orders-list', 'response_invalid', response.status);
  }
  if (page.orders.length === 0 || page.count === 0) return fail('orders-list', 'orders_empty', response.status);
  if (
    page.limit !== 1 || page.offset !== 0 || page.orders.length !== 1 ||
    page.count < page.orders.length ||
    page.orders.some((order) => order.id === missingId || order.customerId !== order.partyId)
  ) {
    return fail('orders-list', 'response_invalid', response.status);
  }
  writeLine('PASS orders-list status=200');
};

export const symmyNegativeProofFailureLine = (error: unknown): string =>
  error instanceof SymmyNegativeProofFailure
    ? `FAIL ${error.check} status=${error.status === undefined ? 'none' : String(error.status)} reason=${error.reason}`
    : 'FAIL configuration status=none reason=unexpected_failure';

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(
      'Usage: node scripts/ops/stage-symmy-negative-proof.mts --run --origin ' +
      `${AKROS_SYMMY_STAGE_ORIGIN} --key-file <private-key-file>\n`,
    );
  } else {
    try {
      const args = parseSymmyNegativeProofArguments(process.argv.slice(2));
      const config = await loadSymmyNegativeProofConfig(args);
      await runSymmyNegativeProof(config, { writeLine: (line) => process.stdout.write(`${line}\n`) });
    } catch (error) {
      process.stderr.write(`${symmyNegativeProofFailureLine(error)}\n`);
      process.exitCode = 1;
    }
  }
}
