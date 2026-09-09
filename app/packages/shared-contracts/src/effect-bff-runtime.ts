/** Server-only assembly for the invariant tail of a strict Effect BFF runtime factory. */
/* oxlint-disable effect-native/no-dependency-parameters -- The approved BFF assembly seam intentionally accepts caller-composed Layers; expires: 2027-09-07. */
import { governedReadHttpStatus } from '@app/core-runtime/http/governed-read';
import { defineEffectBff, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type { EffectRuntimeRequirements, HttpApi, HttpApiGroup } from '@modern-js/plugin-bff/effect-edge';

export interface EffectBffRuntimeAssembly<
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  HandlerRequirements extends EffectRuntimeRequirements,
  TransportRequirements extends EffectRuntimeRequirements = never,
> {
  readonly api: HttpApi.HttpApi<ApiId, Groups>;
  readonly handlers: Layer.Layer<HttpApiGroup.ToService<ApiId, Groups>, never, HandlerRequirements>;
  readonly transport?: Layer.Layer<never, never, TransportRequirements>;
}

export const assembleEffectBffRuntime = <
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  HandlerRequirements extends EffectRuntimeRequirements,
  TransportRequirements extends EffectRuntimeRequirements = never,
>({
  api,
  handlers,
  transport,
}: EffectBffRuntimeAssembly<ApiId, Groups, HandlerRequirements, TransportRequirements>) => {
  const apiLayer = HttpApiBuilder.layer(api).pipe(Layer.provide(handlers));
  const layer = transport === undefined ? apiLayer : apiLayer.pipe(Layer.merge(transport));

  return defineEffectBff({ api, layer });
};

interface GovernedProblemFields<Status extends number> {
  readonly detail: string;
  readonly status: Status;
  readonly title: string;
  readonly type: string;
}

interface GovernedProblemConstructor<Status extends number, Problem> {
  readonly make: (fields: GovernedProblemFields<Status>) => Problem;
}

/** Keeps endpoint-specific error types while centralizing sanitized governed-read responses. */
export const makeGovernedReadProblems = <
  Authentication extends { readonly status: 401 },
  Forbidden extends { readonly status: 403 },
  Internal extends { readonly status: 500 },
  Invalid extends { readonly status: 400 },
  NotFound extends { readonly status: 404 },
  PolicyConflict extends { readonly status: 409 },
  PolicyIneligible extends { readonly status: 422 },
  Unavailable extends { readonly retryable: true; readonly status: 503 },
>(schemas: {
  readonly authentication: GovernedProblemConstructor<401, Authentication>;
  readonly forbidden: GovernedProblemConstructor<403, Forbidden>;
  readonly internal: GovernedProblemConstructor<500, Internal>;
  readonly invalid: GovernedProblemConstructor<400, Invalid>;
  readonly notFound: GovernedProblemConstructor<404, NotFound>;
  readonly policyConflict: GovernedProblemConstructor<409, PolicyConflict>;
  readonly policyIneligible: GovernedProblemConstructor<422, PolicyIneligible>;
  readonly unavailable: {
    readonly make: (fields: GovernedProblemFields<503> & { readonly retryable: true }) => Unavailable;
  };
}) => ({
  authentication: () =>
    schemas.authentication.make({
      detail: 'A valid audience-scoped Bearer assertion is required.',
      status: governedReadHttpStatus.authentication,
      title: 'Authentication required',
      type: 'https://ontos.dev/problems/operation-authentication-required',
    }),
  forbidden: () =>
    schemas.forbidden.make({
      detail: 'The principal is not permitted to perform this read.',
      status: governedReadHttpStatus.forbidden,
      title: 'Read forbidden',
      type: 'https://ontos.dev/problems/read-forbidden',
    }),
  internal: () =>
    schemas.internal.make({
      detail: 'The governed read could not be completed.',
      status: governedReadHttpStatus.internal,
      title: 'Read failed',
      type: 'https://ontos.dev/problems/read-failed',
    }),
  invalid: () =>
    schemas.invalid.make({
      detail: 'The governed read request is invalid.',
      status: governedReadHttpStatus.invalid,
      title: 'Invalid read request',
      type: 'https://ontos.dev/problems/read-invalid',
    }),
  notFound: () =>
    schemas.notFound.make({
      detail: 'The requested resource was not found.',
      status: governedReadHttpStatus.notFound,
      title: 'Resource not found',
      type: 'https://ontos.dev/problems/read-not-found',
    }),
  policyConflict: () =>
    schemas.policyConflict.make({
      detail: 'The read conflicts with the current business state.',
      status: governedReadHttpStatus.policyConflict,
      title: 'Read conflict',
      type: 'https://ontos.dev/problems/read-policy-conflict',
    }),
  policyIneligible: () =>
    schemas.policyIneligible.make({
      detail: 'The read is not eligible under the current business policy.',
      status: governedReadHttpStatus.policyIneligible,
      title: 'Read ineligible',
      type: 'https://ontos.dev/problems/read-policy-denied',
    }),
  unavailable: () =>
    schemas.unavailable.make({
      detail: 'The governed read is temporarily unavailable.',
      retryable: true,
      status: governedReadHttpStatus.unavailable,
      title: 'Read unavailable',
      type: 'https://ontos.dev/problems/read-unavailable',
    }),
});
