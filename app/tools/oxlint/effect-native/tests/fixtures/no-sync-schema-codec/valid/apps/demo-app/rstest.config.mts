// Allowlisted framework config root with an `.mts` extension.
import { Schema } from 'effect';

const RunnerSchema = Schema.Struct({ pool: Schema.String });

export default {
	testEnvironment: Schema.decodeUnknownSync(RunnerSchema)({ pool: 'forks' }).pool,
};
