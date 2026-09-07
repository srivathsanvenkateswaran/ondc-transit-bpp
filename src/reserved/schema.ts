import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * Schema validation for the `TRANSIT.LOCALHOST:INTERCITY` domain.
 *
 * Deliberately a second validator over a second schema tree rather than a
 * parameterisation of the existing one. The two trees share shapes - a
 * descriptor, a price, a tag - and sharing them would mean a change made for
 * one domain silently altering what the other accepts. The duplication is the
 * point, and `tests/reserved/guards.test.ts` asserts that nothing in this
 * tree refs out of it.
 *
 * Twelve documents rather than ten: this domain has a cancellation flow, and
 * the two categories next door do not.
 */

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export interface ReservedValidator {
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
  cancel(value: unknown): ValidationResult;
  onCancel(value: unknown): ValidationResult;
}

function result(validate: ValidateFunction, value: unknown): ValidationResult {
  const valid = validate(value);
  return { valid, errors: validate.errors ?? [] };
}

export function createReservedValidator(schemaRoot: string): ReservedValidator {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
  const readSchema = (name: string) =>
    JSON.parse(readFileSync(join(schemaRoot, `${name}.json`), "utf8"));
  ajv.addSchema(readSchema("common"));
  const compiled = {
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
    cancel: ajv.compile(readSchema("cancel")),
    onCancel: ajv.compile(readSchema("on_cancel")),
  };
  return {
    search: (value) => result(compiled.search, value),
    onSearch: (value) => result(compiled.onSearch, value),
    select: (value) => result(compiled.select, value),
    onSelect: (value) => result(compiled.onSelect, value),
    init: (value) => result(compiled.init, value),
    onInit: (value) => result(compiled.onInit, value),
    confirm: (value) => result(compiled.confirm, value),
    onConfirm: (value) => result(compiled.onConfirm, value),
    status: (value) => result(compiled.status, value),
    onStatus: (value) => result(compiled.onStatus, value),
    cancel: (value) => result(compiled.cancel, value),
    onCancel: (value) => result(compiled.onCancel, value),
  };
}
