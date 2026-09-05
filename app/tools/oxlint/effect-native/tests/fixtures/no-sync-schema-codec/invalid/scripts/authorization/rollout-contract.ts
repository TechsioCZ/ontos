// expect-count: 2
// Operational scripts decode the authorization rollout contract the same way (audit A7).
import { Schema } from 'effect';
import { readFileSync } from 'node:fs';

const RolloutContractSchema = Schema.Struct({ version: Schema.String });

export const readRolloutContract = (file: string): { readonly version: string } =>
	Schema.decodeUnknownSync(RolloutContractSchema, { onExcessProperty: 'preserve' })(
		JSON.parse(readFileSync(file, 'utf8')),
	);

export const writeRolloutContract = (contract: { readonly version: string }): string =>
	JSON.stringify(Schema.encodeSync(RolloutContractSchema)(contract));
