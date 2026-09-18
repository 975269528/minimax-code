interface CanonicalToken {
  readonly kind: TokenKind | null;
  readonly value: string;
  readonly next: number;
}

type TokenKind = 'literal' | 'number' | 'operator' | 'punctuation' | 'quotedIdentifier' | 'word';

const IDENTIFIER_PATTERN = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
const NUMBER_PATTERN = /^(?:0[xX][\dA-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/u;
const MULTI_CHARACTER_OPERATORS = ['->>', '!=', '<>', '<=', '>=', '==', '||', '<<', '>>', '->'];
const QUOTED_IDENTIFIER_CLOSINGS: Readonly<Record<string, string>> = {
  '"': '"',
  '`': '`',
  '[': ']',
};

/**
 * Normalize SQLite DDL into a comparable token contract while preserving semantic differences in
 * string literals, quoted identifiers, and token boundaries. SQL comments are not part of the
 * physical contract.
 */
export function canonicalizeSqlContract(sql: string): string {
  return serializeTokens(readCanonicalTokens(sql));
}

export function canonicalizeSqlDefault(value: string | null): string | null {
  if (value === null) return null;
  const tokens = readCanonicalTokens(value);
  while (hasRedundantOuterParentheses(tokens)) {
    tokens.shift();
    tokens.pop();
  }
  return serializeTokens(tokens);
}

/** Ignore the optional IF NOT EXISTS clause in CREATE statements without rewriting the body or literals. */
export function canonicalizeSqlDefinition(sql: string): string {
  const tokens = readCanonicalTokens(sql);
  const objectKindIndex = tokens.findIndex((candidate, index) =>
    introducesIfNotExists(tokens, candidate, index),
  );
  if (objectKindIndex >= 0) tokens.splice(objectKindIndex + 1, 3);
  return serializeTokens(tokens);
}

/**
 * Normalize SQLite expressions, removing the specified table qualifier only at the identifier-token
 * level. Treat quoted and equivalent unquoted identifiers alike, but preserve string literals
 * unchanged.
 */
export function canonicalizeSqlExpression(sql: string, ignoredQualifier?: string): string {
  const qualifier = ignoredQualifier ? asciiCaseFold(ignoredQualifier) : null;
  const tokens = readCanonicalTokens(sql);
  const normalized: CanonicalToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) break;
    if (
      qualifier !== null &&
      isIdentifier(token, qualifier) &&
      isPunctuation(tokens[index + 1], '.')
    ) {
      index += 1;
      continue;
    }
    normalized.push(token.kind === 'quotedIdentifier' ? { ...token, kind: 'word' } : token);
  }
  return serializeTokens(normalized);
}

export function extractSqlCheckContracts(sql: string): string[] {
  const tokens = readCanonicalTokens(sql);
  const contracts: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isWord(tokens[index], 'check') || !isPunctuation(tokens[index + 1], '(')) continue;
    const closing = findClosingParenthesis(tokens, index + 1);
    if (closing === -1) continue;
    contracts.push(serializeTokens(tokens.slice(index + 2, closing)));
    index = closing;
  }
  return contracts.sort();
}

function readCanonicalTokens(sql: string): CanonicalToken[] {
  const tokens: CanonicalToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const token = readCanonicalToken(sql, index);
    if (token.kind !== null) tokens.push(token);
    index = token.next;
  }
  if (tokens.at(-1)?.kind === 'punctuation' && tokens.at(-1)?.value === ';') tokens.pop();
  return tokens;
}

function hasRedundantOuterParentheses(tokens: readonly CanonicalToken[]): boolean {
  if (!isPunctuation(tokens[0], '(') || !isPunctuation(tokens.at(-1), ')')) return false;
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (isPunctuation(token, '(')) depth += 1;
    if (isPunctuation(token, ')')) depth -= 1;
    if (depth === 0 && index < tokens.length - 1) return false;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function findClosingParenthesis(tokens: readonly CanonicalToken[], opening: number): number {
  let depth = 0;
  for (let index = opening; index < tokens.length; index += 1) {
    if (isPunctuation(tokens[index], '(')) depth += 1;
    if (isPunctuation(tokens[index], ')')) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function introducesIfNotExists(
  tokens: readonly CanonicalToken[],
  candidate: CanonicalToken,
  index: number,
): boolean {
  return (
    index > 0 &&
    index <= 2 &&
    isWord(tokens[0], 'create') &&
    ['index', 'table', 'trigger', 'view'].includes(candidate.value) &&
    candidate.kind === 'word' &&
    isWord(tokens[index + 1], 'if') &&
    isWord(tokens[index + 2], 'not') &&
    isWord(tokens[index + 3], 'exists')
  );
}

function isWord(token: CanonicalToken | undefined, value: string): boolean {
  return token?.kind === 'word' && token.value === value;
}

function isIdentifier(token: CanonicalToken | undefined, value: string): boolean {
  return (token?.kind === 'word' || token?.kind === 'quotedIdentifier') && token.value === value;
}

function isPunctuation(token: CanonicalToken | undefined, value: string): boolean {
  return token?.kind === 'punctuation' && token.value === value;
}

function serializeTokens(tokens: readonly CanonicalToken[]): string {
  return tokens.map(({ kind, value }) => `${kind}:${hexEncode(value)};`).join('');
}

function hexEncode(value: string): string {
  let encoded = '';
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return encoded;
}

function readCanonicalToken(sql: string, index: number): CanonicalToken {
  const current = sql[index] ?? '';
  if (isSqliteWhitespace(current)) return { kind: null, value: '', next: index + 1 };
  const commentEnd = readCommentEnd(sql, index);
  if (commentEnd !== null) return { kind: null, value: '', next: commentEnd };
  if (current === "'") return readStringLiteral(sql, index);
  const identifierClosing = QUOTED_IDENTIFIER_CLOSINGS[current];
  if (identifierClosing) return readQuotedIdentifier(sql, index, identifierClosing);
  return readUnquotedToken(sql, index);
}

function readUnquotedToken(sql: string, index: number): CanonicalToken {
  const remaining = sql.slice(index);
  const identifier = IDENTIFIER_PATTERN.exec(remaining)?.[0];
  if (identifier) return createToken('word', asciiCaseFold(identifier), index);
  const number = NUMBER_PATTERN.exec(remaining)?.[0];
  if (number) return createToken('number', number.toLowerCase(), index);
  const operator = MULTI_CHARACTER_OPERATORS.find((candidate) => remaining.startsWith(candidate));
  if (operator) return createToken('operator', operator, index);
  return createToken('punctuation', sql[index] ?? '', index);
}

function createToken(kind: TokenKind, value: string, start: number): CanonicalToken {
  return { kind, value, next: start + value.length };
}

function isSqliteWhitespace(value: string): boolean {
  const code = value.charCodeAt(0);
  return code === 0x20 || (code >= 0x09 && code <= 0x0d);
}

function asciiCaseFold(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function readCommentEnd(sql: string, start: number): number | null {
  if (sql.startsWith('--', start)) return skipLineComment(sql, start + 2);
  if (sql.startsWith('/*', start)) return skipBlockComment(sql, start + 2);
  return null;
}

function skipLineComment(sql: string, start: number): number {
  const lineFeed = sql.indexOf('\n', start);
  return lineFeed === -1 ? sql.length : lineFeed + 1;
}

function skipBlockComment(sql: string, start: number): number {
  const closing = sql.indexOf('*/', start);
  return closing === -1 ? sql.length : closing + 2;
}

function readStringLiteral(sql: string, start: number): CanonicalToken {
  let value = "'";
  let index = start + 1;
  while (index < sql.length) {
    const current = sql[index] ?? '';
    value += current;
    if (current !== "'") {
      index += 1;
      continue;
    }
    if (sql[index + 1] === "'") {
      value += "'";
      index += 2;
      continue;
    }
    return { kind: 'literal', value, next: index + 1 };
  }
  return { kind: 'literal', value, next: index };
}

function readQuotedIdentifier(sql: string, start: number, closing: string): CanonicalToken {
  let value = '';
  let index = start + 1;
  while (index < sql.length) {
    const current = sql[index] ?? '';
    if (current !== closing) {
      value += asciiCaseFold(current);
      index += 1;
      continue;
    }
    if (sql[index + 1] === closing) {
      value += closing;
      index += 2;
      continue;
    }
    return { kind: 'quotedIdentifier', value, next: index + 1 };
  }
  return { kind: 'quotedIdentifier', value, next: index };
}
