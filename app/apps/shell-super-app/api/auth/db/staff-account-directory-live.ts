import {
  ReadHandlerUnavailable,
  StaffRoleTemplateAccountProvider,
  StaffRoleTemplateAccountsSchema,
  StaffRoleTemplateEmailsSchema,
} from '@app/core-runtime';
import { inArray } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';

import { AuthDatabase } from './client.ts';
import { user } from './schema.ts';
import { StaffAccountDirectory } from './staff-account-directory.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'The staff account directory is temporarily unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Capture Auth's pool once; no Core table, principal reconstruction, or invented login ever belongs here. */
export const StaffAccountDirectoryLive = Layer.effect(
  StaffAccountDirectory,
  Effect.gen(function* makeStaffAccountDirectory() {
    const { executor } = yield* AuthDatabase;
    return {
      lookup: Effect.fn('StaffAccountDirectory.lookup')(function* lookup(emails: readonly string[]) {
        const decoded = yield* Schema.decodeEffect(StaffRoleTemplateEmailsSchema)(emails);
        const bounded = [...new Set(decoded)];
        if (bounded.length === 0) {
          return [];
        }
        const rows = yield* executor
          .select({ email: user.email, providerSubjectId: user.id })
          .from(user)
          .where(inArray(user.email, bounded));
        return yield* Schema.decodeEffect(StaffRoleTemplateAccountsSchema)(rows);
      }, Effect.mapError(unavailable)),
    };
  }),
);

/** Auth implements Core's explicit provider contract; only the native Read invokes it after admission. */
export const BetterAuthStaffRoleTemplateAccountProviderLive = Layer.effect(
  StaffRoleTemplateAccountProvider,
  StaffAccountDirectory,
);
