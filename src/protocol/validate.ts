import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export interface ProtocolValidator {
  search(value: unknown): ValidationResult;
  onSearch(value: unknown): ValidationResult;
  select(value: unknown): ValidationResult;
  onSelect(value: unknown): ValidationResult;
  init(value: unknown): ValidationResult;
  onInit(value: unknown): ValidationResult;
  confirm(value: unknown): ValidationResult;
  onConfirm(value: unknown): ValidationResult;
  status(value: unknown): ValidationResult;
  onStatus(value: unknown): ValidationResult;
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
  (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
  const readSchema = (name: string) =>
    JSON.parse(readFileSync(join(schemaRoot, `${name}.json`), "utf8"));
  ajv.addSchema(readSchema("common"));
  const validators = {
    search: ajv.compile(readSchema("search")),
    onSearch: ajv.compile(readSchema("on_search")),
    select: ajv.compile(readSchema("select")),
    onSelect: ajv.compile(readSchema("on_select")),
    init: ajv.compile(readSchema("init")),
    onInit: ajv.compile(readSchema("on_init")),
    confirm: ajv.compile(readSchema("confirm")),
    onConfirm: ajv.compile(readSchema("on_confirm")),
    status: ajv.compile(readSchema("status")),
    onStatus: ajv.compile(readSchema("on_status")),
  };
  return {
    search: (value) => result(validators.search, value),
    onSearch: (value) => result(validators.onSearch, value),
    select: (value) => result(validators.select, value),
    onSelect: (value) => result(validators.onSelect, value),
    init: (value) => result(validators.init, value),
    onInit: (value) => result(validators.onInit, value),
    confirm: (value) => result(validators.confirm, value),
    onConfirm: (value) => result(validators.onConfirm, value),
    status: (value) => result(validators.status, value),
    onStatus: (value) => result(validators.onStatus, value),
  };
}
