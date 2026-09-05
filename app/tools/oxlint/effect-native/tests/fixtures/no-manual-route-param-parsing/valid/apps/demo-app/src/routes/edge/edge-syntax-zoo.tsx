class Registry {
  #searchParams = new Map<string, string>();
  accessor label: string = 'registry';

  static {
    // static initialisation block
  }

  read(searchParams: string): string | undefined {
    return this.#searchParams.get(searchParams);
  }
}

const Widget = <T,>(props: { readonly value: T }) => <span data-value={String(props.value)} {...props} />;

export const registry = new Registry();
export default Widget;
