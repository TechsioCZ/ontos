// expect-count: 3
import { Effect } from '@modern-js/plugin-bff/effect-edge';
import * as bff from '@modern-js/plugin-bff/effect-edge';

declare const result: { readonly items: readonly { readonly authBindingId: string }[] };
declare const resolver: {
  readonly loadApiKeyBindingForAdministration: (input: {
    readonly authBindingId: string;
  }) => Effect.Effect<string>;
};
declare const left: Effect.Effect<number>;
declare const right: Effect.Effect<number>;

/**
 * `@modern-js/plugin-bff/effect-edge` re-exports Effect's own namespaces, so these are the audit's
 * `apps/shell-super-app/api/index.ts:1243,1315` fan-outs: one remote key-metadata lookup per row,
 * strictly one at a time.
 */
export const items = Effect.forEach(result.items, (binding) =>
  resolver.loadApiKeyBindingForAdministration({ authBindingId: binding.authBindingId }),
);

export const both = Effect.all([left, right]);

// Namespace import of the same barrel: `bff.Effect.forEach`.
export const viaBarrel = bff.Effect.forEach(result.items, (binding) =>
  resolver.loadApiKeyBindingForAdministration({ authBindingId: binding.authBindingId }),
);
