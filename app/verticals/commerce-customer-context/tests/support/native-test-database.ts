import { Config, Effect, Option } from 'effect';

/**
 * The PostgreSQL container these native suites run `psql`/`pg_dump` inside. The shared development
 * Compose service is the default; a lane-owned or CI run names its own disposable container with
 * `ONTOS_TEST_DB_CONTAINER` instead, so a suite never reaches for a database it does not own. Read
 * through `Config` so the requirement is declared, never ambient.
 */
const DEFAULT_DATABASE_CONTAINER = 'ontos-db';

export const nativeTestDatabaseContainer = Effect.gen(function* fixtureDatabaseContainer() {
  const configured = yield* Config.option(Config.String('ONTOS_TEST_DB_CONTAINER'));
  const name = Option.getOrElse(configured, () => DEFAULT_DATABASE_CONTAINER).trim();
  return name.length === 0 ? DEFAULT_DATABASE_CONTAINER : name;
});
