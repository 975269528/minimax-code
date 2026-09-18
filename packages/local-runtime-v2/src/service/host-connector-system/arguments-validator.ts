import { Compile, type Validator } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import type { TSchema } from 'typebox/type';

import type { ConnectorArgumentsDiagnosticIssue } from './errors.js';

const MAX_DIAGNOSTIC_ISSUES = 4;
const MAX_DIAGNOSTIC_PATH_BYTES = 256;

interface ConnectorArgumentsValidator {
  validate(
    value: Readonly<Record<string, unknown>>,
  ): readonly ConnectorArgumentsDiagnosticIssue[] | undefined;
}

/**
 * Compiles the provider schema once for this inventory revision. Schemas that
 * this TypeBox engine cannot compile remain provider-owned and fail open here.
 */
export function compileConnectorArgumentsValidator(
  inputSchemaJson: string,
): ConnectorArgumentsValidator | undefined {
  try {
    const schema = JSON.parse(inputSchemaJson) as unknown;
    if (!isRecord(schema)) return undefined;
    const validator = Compile(schema as TSchema);
    return Object.freeze({
      validate: (value: Readonly<Record<string, unknown>>) => validate(validator, value),
    });
  } catch {
    return undefined;
  }
}

function validate(
  validator: Validator,
  value: Readonly<Record<string, unknown>>,
): readonly ConnectorArgumentsDiagnosticIssue[] | undefined {
  try {
    if (validator.Check(value)) return undefined;
    return Object.freeze(projectIssues(validator.Errors(value), value));
  } catch {
    return undefined;
  }
}

function projectIssues(
  errors: readonly TLocalizedValidationError[],
  value: Readonly<Record<string, unknown>>,
): ConnectorArgumentsDiagnosticIssue[] {
  const issues: ConnectorArgumentsDiagnosticIssue[] = [];
  for (const error of errors) {
    if (error.keyword === 'required') {
      appendRequiredIssues(issues, value, error.instancePath, error.params.requiredProperties);
      if (issues.length === MAX_DIAGNOSTIC_ISSUES) return issues;
      continue;
    }

    const limit = readFiniteLimit(error.params);
    issues.push(
      freezeIssue({
        path: resolveInstancePath(value, error.instancePath),
        constraint: safeConstraint(error.keyword),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
    if (issues.length === MAX_DIAGNOSTIC_ISSUES) return issues;
  }
  return issues;
}

function appendRequiredIssues(
  issues: ConnectorArgumentsDiagnosticIssue[],
  value: Readonly<Record<string, unknown>>,
  instancePath: string,
  requiredProperties: readonly string[],
): void {
  for (const property of requiredProperties) {
    issues.push(
      freezeIssue({ path: requiredPath(value, instancePath, property), constraint: 'required' }),
    );
    if (issues.length === MAX_DIAGNOSTIC_ISSUES) return;
  }
}

function requiredPath(
  value: Readonly<Record<string, unknown>>,
  instancePath: string,
  property: string,
): string {
  const parentTokens = resolveInstancePathTokens(value, instancePath);
  if (!parentTokens || containsControlCharacter(property)) return '';
  return pointerFromTokens([...parentTokens, property]);
}

function resolveInstancePath(
  value: Readonly<Record<string, unknown>>,
  instancePath: string,
): string {
  const tokens = resolveInstancePathTokens(value, instancePath);
  return tokens ? pointerFromTokens(tokens) : '';
}

function resolveInstancePathTokens(value: unknown, instancePath: string): string[] | undefined {
  if (instancePath === '') return [];
  if (!instancePath.startsWith('/') || containsControlCharacter(instancePath)) return undefined;
  const candidates: string[][] = [];
  collectPathCandidates(value, instancePath, [], candidates);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function collectPathCandidates(
  value: unknown,
  remainingPath: string,
  tokens: readonly string[],
  candidates: string[][],
): void {
  if (candidates.length > 1 || !isObject(value)) return;
  for (const key of Object.keys(value)) {
    const prefix = `/${key}`;
    if (remainingPath === prefix) {
      candidates.push([...tokens, key]);
    } else if (remainingPath.startsWith(`${prefix}/`)) {
      collectPathCandidates(
        value[key],
        remainingPath.slice(prefix.length),
        [...tokens, key],
        candidates,
      );
    }
    if (candidates.length > 1) return;
  }
}

function safeConstraint(keyword: string): string {
  return /^[A-Za-z0-9_.~-]+$/u.test(keyword) && Buffer.byteLength(keyword) <= 64
    ? keyword
    : 'schema';
}

function readFiniteLimit(params: object): number | undefined {
  const value = (params as { readonly limit?: unknown }).limit;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function freezeIssue(issue: ConnectorArgumentsDiagnosticIssue): ConnectorArgumentsDiagnosticIssue {
  return Object.freeze(issue);
}

function escapeJsonPointerToken(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function pointerFromTokens(tokens: readonly string[]): string {
  if (tokens.some(containsControlCharacter)) return '';
  const path = tokens.length === 0 ? '' : `/${tokens.map(escapeJsonPointerToken).join('/')}`;
  return Buffer.byteLength(path) <= MAX_DIAGNOSTIC_PATH_BYTES ? path : '';
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
