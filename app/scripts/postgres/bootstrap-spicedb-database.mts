import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { APP_ENV_PATH } from '../../packages/core-runtime/src/environment/workspace-environment.ts';
import { parseSpiceDbDatabaseBootstrapConfig } from './spicedb-database-config.mts';

loadDotenv({ path: APP_ENV_PATH, quiet: true });

const configuration = parseSpiceDbDatabaseBootstrapConfig(process.env);
const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const client = new Client({ connectionString: configuration.adminUrl });

await client.connect();
try {
  const role = await client.query<{ exists: boolean }>(
    'select exists(select 1 from pg_catalog.pg_roles where rolname = $1) as exists',
    [configuration.user],
  );
  const password = quoteLiteral(configuration.password);
  await client.query(
    role.rows[0]?.exists === true
      ? `alter role spicedb login password ${password} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`
      : `create role spicedb login password ${password} nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
  );

  const database = await client.query<{ owner: string }>(
    `select pg_catalog.pg_get_userbyid(datdba) as owner
     from pg_catalog.pg_database
     where datname = $1`,
    [configuration.database],
  );
  if (database.rows.length === 0) {
    await client.query('create database spicedb owner spicedb');
  } else if (database.rows[0]?.owner !== configuration.user) {
    throw new Error('Existing spicedb database must be owned by the spicedb role');
  }
} finally {
  await client.end();
}

console.log('Verified least-privilege PostgreSQL database and role for SpiceDB');
