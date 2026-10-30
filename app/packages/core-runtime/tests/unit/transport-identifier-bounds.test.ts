import { Effect, Exit, Schema } from 'effect';
import { Headers } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ActionTransportMetadataSchema } from '../../src/actions/context.ts';
import { decodeActionEndpointHeaders } from '../../src/http/http-instrumentation-seam.ts';

/**
 * Caller-supplied transport identifiers are persisted verbatim into `action_invocations` and into
 * structured log annotations, so the seam that admits them must bound them. These tests pin the bound for
 * `x-correlation-id` and `x-trace-id`, which previously passed through while `idempotency-key` was bounded.
 */

const headers = (values: Record<string, string>) => Headers.fromInput(values);

const decodeEndpointHeaders = (values: Record<string, string>) =>
  Effect.exit(decodeActionEndpointHeaders(headers(values)));

const decodeTransport = (value: { readonly correlationId: string; readonly traceId?: string }) =>
  Effect.exit(Schema.decodeEffect(ActionTransportMetadataSchema)(value));

it.effect('rejects an over-long x-trace-id at the Action header seam', () =>
  Effect.gen(function* rejectsLongTrace() {
    const exit = yield* decodeEndpointHeaders({ 'x-trace-id': 'T'.repeat(201) });
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('accepts an x-trace-id at the 200 character bound', () =>
  Effect.gen(function* acceptsBoundTrace() {
    const exit = yield* decodeEndpointHeaders({ 'x-trace-id': 'T'.repeat(200) });
    expect(Exit.isSuccess(exit)).toBe(true);
  }),
);

it.effect('rejects a control character in x-trace-id', () =>
  Effect.gen(function* rejectsControlCharacter() {
    const exit = yield* decodeEndpointHeaders({ 'x-trace-id': 'trace\ninjected' });
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('leaves an absent x-trace-id undefined', () =>
  Effect.gen(function* absentTrace() {
    const exit = yield* decodeEndpointHeaders({});
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.traceId).toBe(undefined);
    }
  }),
);

it.effect('still bounds idempotency-key (control)', () =>
  Effect.gen(function* idempotencyControl() {
    const exit = yield* decodeEndpointHeaders({ 'idempotency-key': 'k'.repeat(201) });
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('rejects an over-long correlationId at the declared transport boundary', () =>
  Effect.gen(function* rejectsLongCorrelation() {
    const exit = yield* decodeTransport({ correlationId: 'C'.repeat(201) });
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('rejects an over-long traceId at the declared transport boundary', () =>
  Effect.gen(function* rejectsLongTransportTrace() {
    const exit = yield* decodeTransport({ correlationId: 'correlation-1', traceId: 'T'.repeat(201) });
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('rejects a control character in correlationId at the declared transport boundary', () =>
  Effect.gen(function* rejectsCorrelationControl() {
    const exit = yield* decodeTransport({ correlationId: 'tenant=other\nforged' });
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('accepts bounded identifiers at the declared transport boundary (control)', () =>
  Effect.gen(function* acceptsBoundedTransport() {
    const exit = yield* decodeTransport({ correlationId: 'correlation-1', traceId: 'trace-1' });
    expect(Exit.isSuccess(exit)).toBe(true);
  }),
);
