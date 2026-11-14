import { Context } from 'effect';

import type {
  CommercePortalAuthDatabaseAdapter,
  CommercePortalAuthDatabaseExecutor,
} from './portal-auth-database-types.ts';

/**
 * The portal's database service, declared apart from the pool that provides it. Readers, stores
 * and the audit recorder need only this tag; `portal-auth-database.ts` owns the PgClient pool
 * constructors, so code reachable from the Outbox worker can depend on the service without
 * bundling the pool.
 */
export class CommercePortalAuthDatabase extends Context.Service<
  CommercePortalAuthDatabase,
  {
    readonly adapter: CommercePortalAuthDatabaseAdapter;
    readonly executor: CommercePortalAuthDatabaseExecutor;
  }
>()('@app/commerce-customer-context/portal-auth/persistence/portal-auth-database-service/CommercePortalAuthDatabase') {}
