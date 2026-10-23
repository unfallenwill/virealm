/**
 * Structural type for a JSON Schema document.
 *
 * The schemas are authored as JSON and bundled at generation time, so a
 * narrower TypeScript model would add maintenance without adding safety.
 * Validation of schema correctness belongs to the JSON Schema meta-schema and
 * to the contract tests, not to this alias.
 */
export type JsonSchema = Record<string, unknown>;
