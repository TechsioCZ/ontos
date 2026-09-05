import * as EffectRecord from 'effect/Record';

/** Namespace-imported record helpers with total values stay silent. */
type Annotations = EffectRecord.ReadonlyRecord<string, string>;
type Overrides = Readonly<Record<string, string>>;

/** A locally declared name that merely *looks* ambient is not `NodeJS.ProcessEnv`. */
interface ProcessEnv {
	readonly nodeEnv: string;
	readonly gatewayIssuer: string;
}

type Settings = ProcessEnv;

/** `typeof <schema>.Type` is a type query that has nothing to do with the process environment. */
declare const CustomerSchema: { readonly Type: { readonly id: string } };
type Customer = typeof CustomerSchema.Type;

export const merge = (base: Overrides, extra: Annotations, settings: Settings, customer: Customer): Overrides => ({
	...base,
	...extra,
	nodeEnv: settings.nodeEnv,
	customerId: customer.id,
});
