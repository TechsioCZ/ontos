// A3 targets open hand-threaded dictionary use sites, not closed declaration augmentation itself.
// This declaration alone neither reads nor hand-threads ambient configuration. The value read below
// remains owned by no-ambient-process-env; this rule must not infer config authority from augmentation.
declare global {
	namespace NodeJS {
		interface ProcessEnv {
			readonly ONTOS_DATABASE_URL?: string;
			readonly ONTOS_GATEWAY_ISSUER?: string;
		}
	}
}

export const databaseUrl = process.env.ONTOS_DATABASE_URL;
