// expect-count: 4
import * as Config from 'effect/Config';

export interface LocalCredentials {
  readonly authSecret: string;
  readonly password: string;
  readonly spiceDbPreSharedKey: string;
}

export const AdminDsn = Config.string('POSTGRES_ADMIN_DSN');
