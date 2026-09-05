// The A4 target itself: typed failures on the contract, causes re-raised untouched.
import { Cause, Effect, Exit, Match, Schema } from 'effect';

export class TenantNotFound extends Schema.TaggedError<TenantNotFound>('TenantNotFound')('TenantNotFound', {}) {}
export class TenantConflict extends Schema.TaggedError<TenantConflict>('TenantConflict')('TenantConflict', {}) {}

declare const loadTenant: Effect.Effect<string, TenantNotFound | TenantConflict>;
declare const exit: Exit.Exit<string, TenantNotFound>;

export const handled = loadTenant.pipe(
  Effect.catchTag('TenantNotFound', () => Effect.succeed('anonymous')),
  Effect.catchTags({ TenantConflict: () => Effect.succeed('conflict') }),
);

// Preserving the original cause is the blessed pattern, not a seam.
export const preserved = loadTenant.pipe(
  Effect.tapCause((cause) => Effect.logError('tenant lookup failed', Cause.pretty(cause))),
  Effect.tapErrorCause((cause) => Effect.logDebug('cause preserved', cause)),
);

export const reraise = (cause: Cause.Cause<TenantNotFound>) => Effect.failCause(cause);
export const raised = Effect.failCause(Cause.fail(new TenantNotFound()));
export const defected = Effect.failCause(Cause.die(new Error('boom')));
export const inspected = Exit.isFailure(exit) ? 'failed' : 'ok';
export const matched = Match.type<TenantNotFound | TenantConflict>().pipe(
  Match.tag('TenantNotFound', () => 404),
  Match.tag('TenantConflict', () => 409),
  Match.exhaustive,
);
