// expect-count: 1
/** A8: a codegen package outside scripts/scaffolding is still a generator; route params must be a Schema. */
export const renderFederatedProps = (component: string, parameterType: string): string =>
	`type ${component}RouteParams = Readonly<
  Partial<Record<${parameterType}, string>>
>;

interface ${component}Props {
  readonly routeParams: ${component}RouteParams;
}
`;
