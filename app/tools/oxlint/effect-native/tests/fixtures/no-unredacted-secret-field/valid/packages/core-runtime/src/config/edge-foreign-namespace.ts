// `Schema` and `Config` here come from somewhere that is not `effect`, so nothing resolves.
import { Schema } from 'drizzle-orm';

export const RowSchema = Schema.Struct({ password: Schema.String, secret: Schema.String });

export const Config = { string: (key: string) => key };
export const AuthSecret = Config.string('BETTER_AUTH_SECRET');
