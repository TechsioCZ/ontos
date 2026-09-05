// expect-count: 4
export const emitted = `
// Astral text preserves UTF-16 matching positions: 😀😀😀
const label = '日本語 😀';
import { runPromise as execute } from 'effect/Effect';
export const submit = () => execute(task);
export const operation = () => {
  return Layer.effect(Client)(HttpApiClient.make(Api));
};
const request = async () => await load();
`;
