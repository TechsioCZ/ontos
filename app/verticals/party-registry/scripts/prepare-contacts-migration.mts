// @effect-diagnostics asyncFunction:off globalConsole:off processEnv:off
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';

loadDotenv({ path: APP_ENV_PATH, quiet: true });

export type ContactsJournalState = 'ambiguous' | 'contacts' | 'fresh' | 'legacy';

export const classifyContactsJournalState = (
  legacy: boolean,
  contacts: boolean,
): ContactsJournalState => {
  if (legacy && contacts) {
    return 'ambiguous';
  }
  if (legacy) {
    return 'legacy';
  }
  if (contacts) {
    return 'contacts';
  }
  return 'fresh';
};

export const prepareContactsMigration = async (client: Client): Promise<ContactsJournalState> => {
  await client.query('begin');
  try {
    const result = await client.query<{ contacts: boolean; legacy: boolean }>(
      `select
        to_regclass('drizzle.__drizzle_migrations_crm') is not null as legacy,
        to_regclass('drizzle.__drizzle_migrations_contacts') is not null as contacts`,
    );
    const state = classifyContactsJournalState(
      result.rows[0]?.legacy === true,
      result.rows[0]?.contacts === true,
    );
    if (state === 'ambiguous') {
      throw new Error('Ambiguous Contacts migration state: both CRM and Contacts journals exist');
    }
    if (state === 'legacy') {
      await client.query(
        'alter table drizzle.__drizzle_migrations_crm rename to __drizzle_migrations_contacts',
      );
    }
    await client.query('commit');
    return state;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
};

const main = async (): Promise<void> => {
  const connectionString = process.env['DATABASE_ADMIN_URL']?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_ADMIN_URL is required');
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const state = await prepareContactsMigration(client);
    console.log(`Contacts migration journal preparation: ${state}`);
  } finally {
    await client.end();
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
