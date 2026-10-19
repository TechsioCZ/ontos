// AREA: imports (C03, C04) — owned by the crm-imports lane. Command schemas + reducer.
// To add a command: add a TaggedStruct to importsCommandSchemas and a Match.tag branch in applyImportsCommand.
// CSV parsing may happen in the browser; send parsed rows in the command so the server validates + dedups.
import { Effect, Match, Schema } from 'effect';
import { EntityIdSchema, ShortTextSchema } from '../domain/common.ts';
import type { Reducer } from './context.ts';
import { conflict, notFound, requireWriteAll } from './context.ts';

export const importsCommandSchemas = [
  /** Approve "external customer id X of source S is client Y" (C04-01). */
  Schema.TaggedStruct('LinkExternalCustomer', {
    clientId: EntityIdSchema,
    externalCustomerId: ShortTextSchema,
    source: ShortTextSchema,
  }),
] as const;
export const ImportsCommandSchema = Schema.Union(importsCommandSchemas);
export type ImportsCommand = typeof ImportsCommandSchema.Type;

export const applyImportsCommand: Reducer<ImportsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('LinkExternalCustomer', (value) =>
      Effect.gen(function* linkExternalCustomer() {
        yield* requireWriteAll(context);
        if (!state.clients.items.some((client) => client.id === value.clientId)) {
          return yield* notFound('Klient neexistuje');
        }
        if (
          state.imports.customerLinks.some(
            (link) => link.source === value.source && link.externalCustomerId === value.externalCustomerId,
          )
        ) {
          return yield* conflict('Toto externí zákaznické ID je již propojeno');
        }
        const link = {
          clientId: value.clientId,
          createdAt: context.now,
          createdBy: context.viewer.principalId,
          externalCustomerId: value.externalCustomerId,
          source: value.source,
        };
        return {
          entityIds: [value.clientId],
          state: { ...state, imports: { ...state.imports, customerLinks: [...state.imports.customerLinks, link] } },
        };
      }),
    ),
    Match.exhaustive,
  );
