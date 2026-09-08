// D tier / "Existing patterns to preserve": Promise adapters forced by React and TanStack, one outer
// `runPromise` seam, and native array operations. No throw here is inside an Effect callback.
import { Effect } from 'effect';

declare function useCallback<T>(fn: T, deps: readonly unknown[]): T;
declare function useMutation<T>(options: { readonly mutationFn: () => Promise<T> }): unknown;
declare const program: Effect.Effect<string, Error>;

export function CustomerListPage(): unknown {
  const onSubmit = useCallback(async () => {
    const result = await Effect.runPromise(program);
    if (result.length === 0) {
      throw new Error('the React adapter seam rethrows for the error boundary');
    }
    return result;
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await Effect.runPromise(program);
      if (result.length === 0) {
        throw new Error('TanStack requires a rejected promise');
      }
      return result;
    },
  });

  const labels = ['a', 'b'].map((entry) => {
    if (entry.length === 0) {
      throw new Error('native array operation, D tier');
    }
    return entry;
  });

  return (
    <ul onClick={onSubmit}>
      {labels.map((label) => (
        <li key={label}>{label}</li>
      ))}
      {String(mutation)}
    </ul>
  );
}
