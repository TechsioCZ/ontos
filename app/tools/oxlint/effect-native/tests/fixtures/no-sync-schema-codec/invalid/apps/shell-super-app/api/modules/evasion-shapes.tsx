// expect-count: 6
// TSX + deep submodule namespace alias + class fields, a static block, casts, generics and JSX.
import * as Sch from 'effect/schema/Schema';

const OrderSchema = Sch.Struct({ id: Sch.String });

export class OrderCodec {
	static readonly decode = Sch.decodeUnknownSync(OrderSchema);

	readonly encode = Sch.encodeUnknownSync(OrderSchema);

	static {
		void (Sch.validateSync(OrderSchema) as unknown);
	}

	decodeStrict(value: unknown): { readonly id: string } {
		return (Sch.decodeSync as (schema: typeof OrderSchema) => (raw: unknown) => { readonly id: string })(
			OrderSchema,
		)(value);
	}
}

const parseAll = <T,>(values: readonly T[]): readonly { readonly id: string }[] =>
	values.map(Sch['decodeUnknownSync'](OrderSchema));

export const OrderBadge = ({ raw }: { readonly raw: unknown }): JSX.Element => (
	<span data-count={parseAll([]).length}>
		{(Sch?.decodeUnknownSync(OrderSchema)(raw) satisfies { readonly id: string }).id}
	</span>
);
