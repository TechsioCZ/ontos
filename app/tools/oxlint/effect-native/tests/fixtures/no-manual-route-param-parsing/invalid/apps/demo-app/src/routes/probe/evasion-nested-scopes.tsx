// expect-count: 4
class SearchState {
  readonly params = new URLSearchParams('offset=0');
  static readonly form = new FormData(document.createElement("form"));

  get extra(): URLSearchParams {
    return new URLSearchParams(String(this.params));
  }
}

async function* streamSearches(values: readonly string[]): AsyncGenerator<URLSearchParams> {
  for (const value of values) yield new URLSearchParams(value);
}

const Page = () => (
  <button
    type="button"
    onClick={() => {
      void streamSearches([String(new SearchState().extra), String(SearchState.form)]);
    }}
  >
    go
  </button>
);

export default Page;
