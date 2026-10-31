// expect-count: 2
import { Effect } from 'effect';

type Omit<T, K> = { read: () => string };
interface LogEntry { id: string; message: string; }
export const makeShadowedOmit = (prefix: string, index: number, entry: Omit<LogEntry, 'id'>) =>
  Effect.sync(() => `${prefix}:${index}:${entry.read()}`);

const Schema = { Struct: (_fields: object) => ({ Type: { read: () => 'dependency' } }), String: {} };
const FakeSchema = Schema.Struct({ label: Schema.String });
type FakeData = typeof FakeSchema.Type;
export const createFakeData = (prefix: string, index: number, entry: FakeData) =>
  Effect.sync(() => `${prefix}:${index}:${entry.read()}`);
