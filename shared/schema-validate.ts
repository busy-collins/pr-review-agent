import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

// ============================================================
// Thin Ajv wrapper. Agent JSON schema documents bundle several
// sub-schemas at the top level (e.g. SecurityAgentInput,
// SecurityAgentOutput, SecurityFinding) and reference each other
// via $ref. Validating a sub-schema in isolation breaks ref
// resolution, so we register the whole document with Ajv and then
// look up the sub-schema by JSON pointer.
// ============================================================

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const registry = new WeakMap<object, string>();
let idCounter = 0;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validate(
  rootSchema: object,
  subKey: string,
  data: unknown
): ValidationResult {
  const validator = getValidator(rootSchema, subKey);
  const valid = validator(data) as boolean;
  if (valid) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (validator.errors ?? []).map(formatError),
  };
}

function getValidator(rootSchema: object, subKey: string): ValidateFunction {
  const id = ensureRegistered(rootSchema);
  const ref = `${id}#/${subKey}`;
  const validator = ajv.getSchema(ref);
  if (!validator) {
    throw new Error(`Schema sub-key not found: ${subKey}`);
  }
  return validator;
}

function ensureRegistered(rootSchema: object): string {
  const existing = registry.get(rootSchema);
  if (existing) return existing;
  const id = `__schema_${++idCounter}`;
  // Attach the generated $id to a shallow copy so we don't mutate the
  // caller's imported JSON. Ajv resolves $refs starting from this root.
  const withId = { ...(rootSchema as Record<string, unknown>), $id: id };
  ajv.addSchema(withId, id);
  registry.set(rootSchema, id);
  return id;
}

function formatError(err: ErrorObject): string {
  const path = err.instancePath || '<root>';
  const params = Object.keys(err.params).length
    ? ` ${JSON.stringify(err.params)}`
    : '';
  return `${path}: ${err.message}${params}`;
}
