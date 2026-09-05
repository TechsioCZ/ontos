// expect-count: 11
// Evasion probe: declaration positions a `TSTypePredicate` can hide in inside a TSX component file —
// object-literal methods, class fields (annotation *and* initialiser), decorated methods, `this is T`,
// member assignment, default parameter values, curried factories, an IIFE and a JSX prop callback.
declare function handWritten(value: unknown): boolean;
declare const decorate: (target: unknown, key: string) => void;

export interface Customer {
  readonly id: string;
}

export const guards = {
  isCustomer(value: unknown): value is Customer {
    return handWritten(value);
  },
};

export const mutableGuards: { isCustomer?: (value: unknown) => boolean } = {};
mutableGuards.isCustomer = (value: unknown): value is Customer => handWritten(value);

export const withDefault = (
  guard: (value: unknown) => boolean = (value: unknown): value is Customer => handWritten(value),
) => guard;

export const makeGuard = (prefix: string) => (value: unknown): value is Customer =>
  handWritten(value) && prefix.length > 0;

export const viaIife = ((): ((value: unknown) => value is Customer) => (value): value is Customer =>
  handWritten(value))();

export class CustomerModel {
  readonly isCustomer: (value: unknown) => value is Customer = (value): value is Customer =>
    handWritten(value);

  @decorate
  isDecorated(value: unknown): value is Customer {
    return handWritten(value);
  }

  isLoaded(): this is CustomerModel & { readonly id: string } {
    return handWritten(this);
  }
}

export const CustomerCard = () => (
  <output data-ok={String(guards.isCustomer({}))}>
    {[1, 2].map((entry) => (
      <span key={entry} data-guard={String(((value: unknown): value is Customer => handWritten(value))({}))} />
    ))}
  </output>
);
