// Pathological member syntax that must never report: private fields, `super`, symbol/numeric
// computed access, JSX member expressions and JSX attribute names are not Effect's `Schema`.
import { Schema } from 'effect';

export const IdSchema = Schema.String;

const Panel = {
	Body: (props: { readonly children?: unknown; readonly decodeUnknownSync?: unknown }): JSX.Element => (
		<span>{String(props.children)}</span>
	),
};

class BaseCodec {
	decodeUnknownSync(value: unknown): string {
		return String(value);
	}
}

export class LocalCodec extends BaseCodec {
	readonly #decodeUnknownSync = (value: unknown): string => String(value);

	override decodeUnknownSync(value: unknown): string {
		return super.decodeUnknownSync(this.#decodeUnknownSync(value));
	}
}

const table = ['a'];
export const first = table[0];
export const iterate = table[Symbol.iterator];

const key = 'decodeUnknownSync';
export const dynamic = { [key]: 1 };

export const Badge = (): JSX.Element => (
	<Panel.Body decodeUnknownSync={new LocalCodec().decodeUnknownSync}>{first satisfies string | undefined}</Panel.Body>
);
