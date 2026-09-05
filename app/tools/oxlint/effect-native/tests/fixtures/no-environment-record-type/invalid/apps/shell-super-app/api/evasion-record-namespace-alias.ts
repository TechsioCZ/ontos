// expect-count: 1
// Same spelling the valid fixture blesses for total maps (`EffectRecord.ReadonlyRecord<string, string>`),
// but with the optional value that makes it an environment bag.
import * as EffectRecord from 'effect/Record';

export type NamespaceEnvironment = EffectRecord.ReadonlyRecord<string, string | undefined>;

export const readIssuer = (environment: NamespaceEnvironment): string | undefined =>
	environment['ONTOS_GATEWAY_ISSUER'];
