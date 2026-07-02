// @effect-diagnostics globalDate:off
import { relations } from 'drizzle-orm';
import { boolean, index, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

export const user = authSchema.table('user', {
  createdAt: timestamp('created_at').defaultNow().notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  id: text('id').primaryKey(),
  image: text('image'),
  name: text('name').notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = authSchema.table(
  'session',
  {
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    id: text('id').primaryKey(),
    ipAddress: text('ip_address'),
    token: text('token').notNull().unique(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('auth_session_user_id_idx').on(table.userId)],
);

export const account = authSchema.table(
  'account',
  {
    accessToken: text('access_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    accountId: text('account_id').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    id: text('id').primaryKey(),
    idToken: text('id_token'),
    password: text('password'),
    providerId: text('provider_id').notNull(),
    refreshToken: text('refresh_token'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('auth_account_user_id_idx').on(table.userId)],
);

export const verification = authSchema.table(
  'verification',
  {
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    value: text('value').notNull(),
  },
  (table) => [index('auth_verification_identifier_idx').on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  accounts: many(account),
  sessions: many(session),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const authTables = {
  account,
  session,
  user,
  verification,
};
