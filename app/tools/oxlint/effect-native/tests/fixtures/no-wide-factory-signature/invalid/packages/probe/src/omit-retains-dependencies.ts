// expect-count: 3
import { Context, Effect, Schema } from 'effect';

interface LogEntry { id: string; message: string; }

// A data projection in one argument does not make an injected Context a data parameter.
export const makeContextEntry = (context: Context.Context<never>, index: number, entry: Omit<LogEntry, 'id'>) =>
  Effect.succeed({ context, index, entry });

interface Dependencies {
  label: string;
  read(): string;
}
export const buildDependencyEntry = (prefix: string, index: number, entry: Omit<Dependencies, 'label'>) =>
  Effect.sync(() => `${prefix}:${index}:${entry.read()}`);

const DependencySchema = Schema.Struct({
  label: Schema.String,
  read: Schema.declare<() => string>(() => true),
});
type SchemaDependency = typeof DependencySchema.Type;
// Schema.Type is not itself proof of data: an opaque callable remains a collaborator.
export const createSchemaDependency = (prefix: string, index: number, entry: Omit<SchemaDependency, 'label'>) =>
  Effect.sync(() => `${prefix}:${index}:${entry.read()}`);
