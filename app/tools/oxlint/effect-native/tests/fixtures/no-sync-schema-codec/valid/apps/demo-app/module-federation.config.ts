// Allowlisted framework/build configuration root: evaluated by the bundler before any Effect
// runtime exists, so throwing IS the failure channel ("single outer framework adapter seam").
import { Schema } from 'effect';

const PackageVersionSchema = Schema.Struct({ version: Schema.String });

const versionOf = (specifier: string): string =>
	Schema.decodeUnknownSync(PackageVersionSchema)(require(specifier)).version;

export default {
	name: 'demo',
	shared: { react: { requiredVersion: versionOf('react/package.json') } },
};
