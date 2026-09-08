// Parser stress: decorators plus JSX in a script, with no Effect import at all.
const marker = (): MethodDecorator => (): void => undefined;

export class Annotated {
	@marker()
	render(): unknown {
		return <span>ok</span>;
	}
}
