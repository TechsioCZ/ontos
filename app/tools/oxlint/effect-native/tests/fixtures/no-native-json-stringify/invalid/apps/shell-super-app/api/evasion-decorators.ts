// expect-count: 3
// Decorator arguments and `accessor` fields are ordinary expression positions.
declare const v: unknown;
declare function Meta(value: string): ClassDecorator;
declare function Column(value: string): PropertyDecorator;

@Meta(JSON.stringify({ kind: "service" }))
export class Service {
	@Column(JSON.stringify({ column: "payload" }))
	payload!: string;

	accessor cached: string = JSON.stringify(v);
}
