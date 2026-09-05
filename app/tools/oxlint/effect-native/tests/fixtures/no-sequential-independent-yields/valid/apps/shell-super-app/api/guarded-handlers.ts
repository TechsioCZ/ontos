// Precondition guards named after their ordering (`authenticated` is a run head, `requiredIdempotencyKey`
// is a barrier) and a `Context.Service` tag yielded as a bare identifier. None of these are reported.
import { Effect } from 'effect';

declare const authenticated: (request: Request) => Effect.Effect<{ readonly resolved: string }>;
declare const requiredIdempotencyKey: (headers: Headers) => Effect.Effect<string>;
declare const ensureTenantActive: (tenant: string) => Effect.Effect<string>;
declare const lifecycle: Effect.Effect<{ readonly create: (key: string) => Effect.Effect<string> }>;

export const createPrincipal = (request: Request, headers: Headers) =>
  Effect.gen(function* createNonHumanPrincipalHandler() {
    const { resolved } = yield* authenticated(request);
    const idempotencyKey = yield* requiredIdempotencyKey(headers);
    const active = yield* ensureTenantActive(resolved);
    const service = yield* lifecycle;
    return yield* service.create(idempotencyKey + active);
  });
