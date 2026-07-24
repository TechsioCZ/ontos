# UltraModern.js MicroVertical Rules

Follow these rules when writing code with MicroVerticals:

- Always use Effect TS wherever possible.
- Always prefer direct object, method, and variable references over string constants.
- Do not create an abstraction without a concrete reuse case.
- Always write the simplest code possible without introducing new concepts, classes, variables, or files.
- Always inspect the Codesmith generators in `src/scripts` and use them to generate code first. Generate as much code as possible, then fill in the logic. Never generate new files while working on business functionality. You may generate new files only when working on infrastructure or architecture.
