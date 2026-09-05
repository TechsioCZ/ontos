// expect-count: 3
// Evasion: the credential key literal is wrapped so `arguments[0].type !== "Literal"`.
// The rule already owns `unwrap()` for TSAsExpression / TSSatisfiesExpression but never applies
// it to the Config argument, and a no-substitution template literal is not a `Literal` node.
import { Config } from 'effect';

export const AuthSecret = Config.string(`BETTER_AUTH_SECRET`);
export const SpiceDbKey = Config.string('SPICEDB_PRESHARED_KEY' as const);
export const AdminDsn = Config.nonEmptyString('POSTGRES_ADMIN_DSN' satisfies string);

// Public keys in the same shapes must stay silent.
export const Issuer = Config.string(`ONTOS_GATEWAY_ISSUER`);
export const Jwks = Config.string('ONTOS_GATEWAY_PUBLIC_JWKS' as const);
