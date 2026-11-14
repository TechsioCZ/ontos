// Owner manifests include browser styles. Match the Modern.js stylesheet contract without importing
// its application-only ProcessEnv globals into Node tooling.
declare module '*.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
