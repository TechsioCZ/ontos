/** Parser stress probe: decorators, abstract/declare members, index signature, and a template inside a
 *  decorator argument. Nothing here is emitted Promise-first code, so nothing must report. */
function tagged(value: unknown, context: ClassMethodDecoratorContext): void {
	void value;
	void context;
}

export abstract class BaseScaffold {
	declare readonly name: string;
	abstract render(component: string): string;

	@tagged
	describe(): string {
		return `${this.name} scaffold`;
	}
}

export class PageScaffold extends BaseScaffold {
	readonly [key: string]: unknown;

	override render(component: string): string {
		return `export const ${component} = () => null;\n`;
	}
}
