/** Namespace-qualified failure class: `instanceof` is anchored to a bare identifier. */
export const renderPanel = (name: string): string => `
export const ${name}Panel = () => {
  if (error instanceof Errors.ValidationError) {
    return <Invalid />;
  }
  return <Ready />;
};
`;
