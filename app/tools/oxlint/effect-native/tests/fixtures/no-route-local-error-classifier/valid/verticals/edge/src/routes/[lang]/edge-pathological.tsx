// Crash probe: decorators, accessors, private fields, rest/default/destructured parameters,
// unicode identifiers, labelled statements, namespaced JSX and non-null/`as` chains — none of
// which classify a failure, so the rule must stay silent (and must not throw).
declare const inject: (target: unknown, key?: unknown) => void;
declare const Ns: { readonly Sub: (props: { readonly children?: unknown }) => unknown };

@inject
export class Panel {
  @inject accessor state = 'idle';
  #rows: readonly string[] = [];
  constructor(private readonly label: string) {}
  render(this: void, ...rows: readonly string[]) {
    return rows.length;
  }
}

export const 𝑥unicodeLabel = ({ id = 'row', ...rest }: { id?: string }) => `${id}-${String(rest)}`;

export function Wild(first?: { readonly nested?: { readonly value?: string } }) {
  outer: for (const _ of []) {
    break outer;
  }
  return <Ns.Sub>{first?.nested?.value!.trim() as unknown as string}</Ns.Sub>;
}

export default (rows: readonly string[]) => rows.length;
