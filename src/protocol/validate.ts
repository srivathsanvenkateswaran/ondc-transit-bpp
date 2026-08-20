import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export interface ProtocolValidator {
  search(value: unknown): ValidationResult;
  onSearch(value: unknown): ValidationResult;
}

function result(validate: ValidateFunction, value: unknown): ValidationResult {
  const valid = validate(value);
  return { valid, errors: validate.errors ?? [] };
}

export function createProtocolValidator(schemaRoot: string): ProtocolValidator {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  const searchSchema = JSON.parse(
    readFileSync(join(schemaRoot, "search.json"), "utf8"),
  );
  const onSearchSchema = JSON.parse(
    readFileSync(join(schemaRoot, "on_search.json"), "utf8"),
  );
  const validateSearch = ajv.compile(searchSchema);
  const validateOnSearch = ajv.compile(onSearchSchema);
  return {
    search: (value) => result(validateSearch, value),
    onSearch: (value) => result(validateOnSearch, value),
  };
}
