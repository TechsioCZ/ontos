import { fileURLToPath } from 'node:url';

import { Effect, FileSystem } from 'effect';

/** Fresh historical fixtures select the same reviewed main lineage as the convergence planner. */
export const historicalContactsMigrationFolder = Effect.fn('PartyUpgrade.contactsMigrationFolder')(
  function* contactsMigrationFolder() {
    const fs = yield* FileSystem.FileSystem;
    const source = fileURLToPath(new URL('../../drizzle-contacts/', import.meta.url));
    const target = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-party-contacts-upgrade-' });
    for (const name of yield* fs.readDirectory(source)) {
      // The reviewed demo alias is identical SQL, not another migration to execute after main.
      if (
        name === '20261024090301_contacts-gateway-scope-rls' ||
        !(yield* fs.exists(`${source}/${name}/migration.sql`))
      ) {
        continue;
      }
      yield* fs.makeDirectory(`${target}/${name}`);
      yield* fs.copyFile(`${source}/${name}/migration.sql`, `${target}/${name}/migration.sql`);
      yield* fs.copyFile(`${source}/${name}/snapshot.json`, `${target}/${name}/snapshot.json`);
    }
    return target;
  },
);
