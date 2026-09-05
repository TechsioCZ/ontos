// expect-count: 4
// A4/S1: local catches do not exempt their own rethrows, finally blocks or shadowed framework APIs.
import { Effect } from 'effect';
import { useMutation } from '@tanstack/react-query';
export const rethrow = Effect.sync(() => {
  try { throw 'caught locally'; } catch (cause) { throw cause; }
});
export const cleanup = Effect.sync(() => {
  try { throw 'no catch'; } finally { throw 'cleanup failure'; }
});
export function shadow(useMutation: (options: { mutationFn: () => never }) => unknown) {
  return Effect.sync(() => useMutation({mutationFn: () => { throw 'not a framework adapter'; }}));
}
