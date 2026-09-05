// expect-count: 4
// `.mts` script: async generator, nested arrow bodies, top-level await, optional computed access.
import { Schema } from 'effect';

const TopologySchema = Schema.Struct({ id: Schema.String });

export async function* readTopologies(files: readonly string[]): AsyncGenerator<{ readonly id: string }> {
	for (const file of files) {
		yield Schema.decodeUnknownSync(TopologySchema)(JSON.parse(file));
	}
}

const lazily = () => () => async () => Schema.decodeUnknownSync(TopologySchema);

export const eagerly = await (async () => Schema.encodeSync(TopologySchema))();

export const validated = Schema?.['validateSync'](TopologySchema);

export const wired = [lazily, eagerly, validated];
