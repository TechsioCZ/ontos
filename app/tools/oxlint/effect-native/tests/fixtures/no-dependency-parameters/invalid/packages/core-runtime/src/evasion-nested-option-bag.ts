// expect-count: 2
import { Effect } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}

// 1: one nesting level below the option bag still hides the same graph edge.
export const boot = (options: {
  readonly label: string;
  readonly dependencies: { readonly gateway: ContactsGateway };
}) => options.label;

// 2: the same, through a same-module interface.
export interface RuntimeOptions {
  readonly label: string;
  readonly dependencies: { readonly gateway: ContactsGateway };
}
export const start = (options: RuntimeOptions) => options.label;
