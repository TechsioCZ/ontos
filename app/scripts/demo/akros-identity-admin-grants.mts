#!/usr/bin/env node
/** LOCAL ONLY: restore the existing AKROS company-admin role; never grant tenant administration. */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';

import { repairAdministratorRelationships } from './accounts-admin-grants.mts';
import { akrosDemoLegalEntityId, demoId } from './fixture-ids.mts';
import { principalRelationships } from './permissions.mts';

const program = Effect.gen(function* repairAkrosCompanyAdministrator() {
  const relationships = yield* Effect.try(() =>
    principalRelationships(
      demoId('core.principal', 'akros-eshop'),
      { companyRole: 'admin', label: 'Company administrator', modules: {} },
      [],
      akrosDemoLegalEntityId,
    ),
  );
  yield* repairAdministratorRelationships(relationships);
  yield* Console.log('AKROS company-admin role restored; no tenant-admin grant, identities or records reset.');
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

if (import.meta.main) {
  await Effect.runPromise(program);
}
