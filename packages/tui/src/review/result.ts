import { SaxesParser } from 'saxes';

import { sanitizeTerminalText } from '../tui/rendering/terminal-text.js';

export type TuiReviewOutcome = 'pass' | 'needs_changes' | 'failed';
export type TuiReviewPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TuiReviewMode = 'inline' | 'subagent';
export type TuiReviewSide = 'old' | 'new';

export interface TuiReviewFinding {
  readonly id: string;
  readonly priority: TuiReviewPriority;
  readonly targetType: 'line-range' | 'file';
  readonly path: string;
  readonly side?: TuiReviewSide;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly title: string;
  readonly content: string;
}

/** Stable Review payload embedded in an `exec.result` for `mcode exec review`. */
export interface ReviewResultV1 {
  readonly schemaVersion: 1;
  readonly type: 'review.result';
  readonly scope: 'local_changes';
  readonly verdict: 'pass' | 'needs_changes';
  readonly summary: string;
  readonly findings: readonly TuiReviewFinding[];
  readonly mode?: TuiReviewMode;
}

interface XmlNode {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

const MAX_DOCUMENT_LENGTH = 1_000_000;
const MAX_NODE_COUNT = 1_000;
const MAX_DEPTH = 32;
const SAFE_RELATIVE_PATH_RE =
  /^(?![A-Za-z]:[\\/])(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\0]+$/u;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const GIT_BLOB_RE = /^git-blob:[a-f0-9]{40,64}$/u;

export function reviewOutcomeFromOrigin(origin: unknown): TuiReviewOutcome | undefined {
  if (!isRecord(origin)) return undefined;
  const outcome = origin.reviewOutcome;
  return outcome === 'pass' || outcome === 'needs_changes' || outcome === 'failed'
    ? outcome
    : undefined;
}

export function parseTuiReviewResult(input: string): ReviewResultV1 | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('<annotation-result') || !trimmed.endsWith('</annotation-result>')) {
    return undefined;
  }
  try {
    const root = parseXmlDocument(trimmed);
    assertElement(root, 'annotation-result');
    assertAttributes(root, ['version', 'source', 'review-run-id', 'trigger', 'mode', 'verdict']);
    if (
      requiredAttribute(root, 'version') !== '2' ||
      requiredAttribute(root, 'source') !== 'code-review' ||
      requiredAttribute(root, 'verdict') !== 'needs-changes' ||
      !requiredAttribute(root, 'review-run-id')
    ) {
      return undefined;
    }
    const trigger = requiredAttribute(root, 'trigger');
    const mode = requiredAttribute(root, 'mode');
    if (
      (trigger !== 'slash' && trigger !== 'natural_language') ||
      (mode !== 'inline' && mode !== 'subagent')
    ) {
      return undefined;
    }
    assertWhitespaceOnly(root);
    assertChildNames(root, ['summary', 'annotations']);
    const summary = readTextElement(onlyChild(root, 'summary'));
    const annotations = onlyChild(root, 'annotations');
    assertAttributes(annotations, []);
    assertWhitespaceOnly(annotations);
    if (annotations.children.some((child) => child.name !== 'annotation')) return undefined;
    const findings = annotations.children.map(parseFinding);
    if (!summary || findings.length === 0) return undefined;
    return {
      schemaVersion: 1,
      type: 'review.result',
      scope: 'local_changes',
      verdict: 'needs_changes',
      summary,
      findings,
      mode,
    };
  } catch {
    return undefined;
  }
}

export function createPassingReviewResult(summary: string): ReviewResultV1 | undefined {
  const normalized = summary.trim();
  if (!normalized) return undefined;
  return {
    schemaVersion: 1,
    type: 'review.result',
    scope: 'local_changes',
    verdict: 'pass',
    summary: normalized,
    findings: [],
  };
}

export function isReviewResultV1(value: unknown): value is ReviewResultV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.type !== 'review.result') {
    return false;
  }
  if (
    value.scope !== 'local_changes' ||
    (value.verdict !== 'pass' && value.verdict !== 'needs_changes') ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    !Array.isArray(value.findings) ||
    !value.findings.every(isTuiReviewFinding) ||
    (value.mode !== undefined && value.mode !== 'inline' && value.mode !== 'subagent')
  ) {
    return false;
  }
  return value.verdict === 'pass' ? value.findings.length === 0 : value.findings.length > 0;
}

export function renderReviewResultText(result: ReviewResultV1): string {
  if (result.verdict === 'pass') return sanitizeTerminalText(result.summary);
  return [
    sanitizeTerminalText(result.summary),
    ...result.findings.flatMap((finding) => [
      '',
      `[${finding.priority}] ${sanitizeTerminalText(finding.title)}`,
      sanitizeTerminalText(formatFindingLocation(finding)),
      sanitizeTerminalText(finding.content),
    ]),
  ].join('\n');
}

export function formatFindingLocation(finding: TuiReviewFinding): string {
  if (finding.targetType === 'file') return finding.path;
  const range =
    finding.startLine === finding.endLine
      ? String(finding.startLine)
      : `${String(finding.startLine)}-${String(finding.endLine)}`;
  return `${finding.path}:${range}${finding.side ? ` (${finding.side})` : ''}`;
}

function parseFinding(node: XmlNode): TuiReviewFinding {
  assertElement(node, 'annotation');
  assertAttributes(node, ['id', 'kind', 'priority']);
  if (requiredAttribute(node, 'kind') !== 'code-review') {
    throw new Error('annotation kind must be code-review');
  }
  const id = requiredAttribute(node, 'id');
  const priority = requiredAttribute(node, 'priority');
  if (!id || !isPriority(priority)) throw new Error('annotation identity is invalid');
  assertWhitespaceOnly(node);
  assertChildNames(node, ['target', 'title', 'content']);
  const target = parseTarget(onlyChild(node, 'target'));
  const title = readTextElement(onlyChild(node, 'title'));
  const content = readTextElement(onlyChild(node, 'content'));
  if (!title || !content) throw new Error('annotation text is empty');
  return { id, priority, ...target, title, content };
}

function parseTarget(
  node: XmlNode,
): Pick<TuiReviewFinding, 'targetType' | 'path' | 'side' | 'startLine' | 'endLine'> {
  assertElement(node, 'target');
  const path = requiredAttribute(node, 'uri');
  if (!SAFE_RELATIVE_PATH_RE.test(path) || requiredAttribute(node, 'type') !== 'file') {
    throw new Error('annotation target is invalid');
  }
  assertWhitespaceOnly(node);
  if (node.attributes.state === 'deleted') {
    assertAttributes(node, ['type', 'uri', 'state', 'blob-revision']);
    if (node.children.length > 0 || !GIT_BLOB_RE.test(requiredAttribute(node, 'blob-revision'))) {
      throw new Error('deleted annotation target is invalid');
    }
    return { targetType: 'file', path };
  }
  assertAttributes(node, ['type', 'uri']);
  assertChildNames(node, ['selector', 'related-change']);
  const selector = onlyChild(node, 'selector');
  assertAttributes(selector, [
    'type',
    'side',
    'start-line',
    'end-line',
    'anchor-revision',
    'context-before',
    'context-after',
  ]);
  assertWhitespaceOnly(selector);
  if (selector.children.length > 0 || requiredAttribute(selector, 'type') !== 'line-range') {
    throw new Error('annotation selector is invalid');
  }
  const side = requiredAttribute(selector, 'side');
  const startLine = positiveInteger(requiredAttribute(selector, 'start-line'));
  const endLine = positiveInteger(requiredAttribute(selector, 'end-line'));
  const anchorRevision = selector.attributes['anchor-revision'];
  if (
    (side !== 'old' && side !== 'new') ||
    endLine < startLine ||
    (anchorRevision !== undefined && !SHA256_RE.test(anchorRevision)) ||
    !isContextCount(selector.attributes['context-before']) ||
    !isContextCount(selector.attributes['context-after'])
  ) {
    throw new Error('annotation selector is invalid');
  }
  const related = optionalChild(node, 'related-change');
  if (related) validateRelatedChange(related);
  return { targetType: 'line-range', path, side, startLine, endLine };
}

function validateRelatedChange(node: XmlNode): void {
  assertAttributes(node, ['path', 'side', 'start-line', 'end-line', 'revision']);
  assertWhitespaceOnly(node);
  const path = requiredAttribute(node, 'path');
  const side = requiredAttribute(node, 'side');
  const startLine = positiveInteger(requiredAttribute(node, 'start-line'));
  const endLine = positiveInteger(requiredAttribute(node, 'end-line'));
  if (
    node.children.length > 0 ||
    !SAFE_RELATIVE_PATH_RE.test(path) ||
    (side !== 'old' && side !== 'new') ||
    endLine < startLine ||
    !SHA256_RE.test(requiredAttribute(node, 'revision'))
  ) {
    throw new Error('related change is invalid');
  }
}

function parseXmlDocument(source: string): XmlNode {
  if (source.length > MAX_DOCUMENT_LENGTH) throw new Error('Review result is too large');
  let root: XmlNode | undefined;
  let invalid = false;
  let nodeCount = 0;
  let outsideText = '';
  const stack: XmlNode[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => {
    nodeCount += 1;
    if (nodeCount > MAX_NODE_COUNT || stack.length >= MAX_DEPTH) invalid = true;
    const node: XmlNode = {
      name: tag.name,
      attributes: Object.fromEntries(
        Object.entries(tag.attributes).map(([key, value]) => [key, String(value)]),
      ),
      children: [],
      text: '',
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) invalid = true;
    else root = node;
    stack.push(node);
  });
  parser.on('text', (text) => {
    const current = stack.at(-1);
    if (current) current.text += text;
    else outsideText += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('cdata', () => {
    invalid = true;
  });
  parser.on('comment', () => {
    invalid = true;
  });
  parser.on('doctype', () => {
    invalid = true;
  });
  parser.on('processinginstruction', () => {
    invalid = true;
  });
  parser.on('error', () => {
    invalid = true;
  });
  parser.write(source).close();
  if (invalid || !root || stack.length > 0 || outsideText.trim()) {
    throw new Error('Review result XML is invalid');
  }
  return root;
}

function readTextElement(node: XmlNode): string {
  assertAttributes(node, []);
  if (node.children.length > 0) throw new Error(`${node.name} must contain text only`);
  return node.text.trim();
}

function assertElement(node: XmlNode, name: string): void {
  if (node.name !== name) throw new Error(`Expected ${name}`);
}

function assertAttributes(node: XmlNode, names: readonly string[]): void {
  const expected = [...names].sort().join('\0');
  const actual = Object.keys(node.attributes).sort().join('\0');
  if (actual !== expected) throw new Error(`${node.name} attributes are invalid`);
}

function assertWhitespaceOnly(node: XmlNode): void {
  if (node.text.trim()) throw new Error(`${node.name} contains unexpected text`);
}

function assertChildNames(node: XmlNode, names: readonly string[]): void {
  const allowed = new Set(names);
  if (node.children.some((child) => !allowed.has(child.name))) {
    throw new Error(`${node.name} contains an unexpected element`);
  }
}

function onlyChild(node: XmlNode, name: string): XmlNode {
  const children = node.children.filter((child) => child.name === name);
  const child = children[0];
  if (children.length !== 1 || !child) {
    throw new Error(`${node.name} must contain one ${name}`);
  }
  return child;
}

function optionalChild(node: XmlNode, name: string): XmlNode | undefined {
  const children = node.children.filter((child) => child.name === name);
  if (children.length > 1) throw new Error(`${node.name} contains duplicate ${name}`);
  return children[0];
}

function requiredAttribute(node: XmlNode, name: string): string {
  const value = node.attributes[name];
  if (value === undefined) throw new Error(`${node.name}.${name} is required`);
  return value;
}

function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error('Expected a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Integer is out of range');
  return parsed;
}

function isContextCount(value: string | undefined): boolean {
  return value === undefined || /^[0-3]$/u.test(value);
}

function isPriority(value: string): value is TuiReviewPriority {
  return value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3';
}

function isTuiReviewFinding(value: unknown): value is TuiReviewFinding {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.priority !== 'string' ||
    !isPriority(value.priority) ||
    typeof value.path !== 'string' ||
    !SAFE_RELATIVE_PATH_RE.test(value.path) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    typeof value.content !== 'string' ||
    !value.content.trim()
  ) {
    return false;
  }
  if (value.targetType === 'file') {
    return value.side === undefined && value.startLine === undefined && value.endLine === undefined;
  }
  return (
    value.targetType === 'line-range' &&
    (value.side === 'old' || value.side === 'new') &&
    typeof value.startLine === 'number' &&
    Number.isSafeInteger(value.startLine) &&
    value.startLine > 0 &&
    typeof value.endLine === 'number' &&
    Number.isSafeInteger(value.endLine) &&
    value.endLine >= value.startLine
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
