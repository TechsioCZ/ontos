// Parser probe: decorators + fragments in a .tsx script, no console anywhere.
function tag(_value: unknown, _context: ClassMethodDecoratorContext): void {}

export class Panel {
	@tag
	render(): unknown {
		return (
			<>
				<em>ok</em>
			</>
		);
	}
}
