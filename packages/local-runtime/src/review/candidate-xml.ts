import { SaxesParser } from 'saxes';

const MAX_DOCUMENT_LENGTH = 1_000_000;
const MAX_NODE_COUNT = 1_000;
const MAX_DEPTH = 32;

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const FINDING_PARSE_ERROR_FIELD = '__reviewCandidateFindingParseError';

export function getReviewCandidateFindingParseError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = (value as Record<string, unknown>)[FINDING_PARSE_ERROR_FIELD];
  return typeof message === 'string' ? message : undefined;
}

export function parseReviewCandidateXml(text: string): unknown {
  const root = parseXmlDocument(text);
  if (root.name === 'review-candidates') return parseCandidateDocument(root);
  if (root.name === 'annotation-result') return parseUntrustedAnnotationResult(root);
  throw new Error(`Unexpected review candidate XML root: ${root.name}`);
}

export function parseReviewCandidateCorrectionsXml(text: string): unknown {
  const root = parseXmlDocument(text);
  assertElement(root, 'review-candidate-corrections');
  assertAttributes(root, ['version']);
  if (requiredAttribute(root, 'version') !== '1') {
    throw new Error('review-candidate-corrections version must be 1');
  }
  assertWhitespaceOnly(root);

  return {
    type: 'code_review_candidate_corrections',
    version: 1,
    corrections: root.children.map((node) => {
      assertElement(node, 'correction');
      assertAttributes(node, ['candidate-key', 'action']);
      assertWhitespaceOnly(node);
      const candidateKey = requiredAttribute(node, 'candidate-key');
      const action = requiredAttribute(node, 'action');
      if (action === 'drop') {
        if (node.children.length !== 0) {
          throw new Error('drop correction must not contain a finding');
        }
        return { candidateKey, action };
      }
      if (action !== 'replace') {
        throw new Error(`Unsupported review correction action: ${action}`);
      }
      return {
        candidateKey,
        action,
        finding: parseCandidateFinding(onlyChild(node, 'finding')),
      };
    }),
  };
}

function parseCandidateDocument(root: XmlNode): unknown {
  assertAttributes(root, ['version', 'verdict']);
  if (requiredAttribute(root, 'version') !== '2') {
    throw new Error('review-candidates version must be 2');
  }
  assertWhitespaceOnly(root);
  assertChildNames(root, ['summary', 'findings']);
  const verdict = requiredAttribute(root, 'verdict');
  if (verdict !== 'pass' && verdict !== 'needs-changes') {
    throw new Error(`Unsupported review verdict: ${verdict}`);
  }
  const findings = onlyChild(root, 'findings');
  assertAttributes(findings, []);
  assertWhitespaceOnly(findings);
  return {
    type: 'code_review_candidates',
    version: 2,
    summary: readTextElement(onlyChild(root, 'summary')),
    verdict,
    findings: findings.children.map(parseCandidateFindingIsolated),
  };
}

function parseCandidateFindingIsolated(node: XmlNode): unknown {
  try {
    return parseCandidateFinding(node);
  } catch (error) {
    return {
      [FINDING_PARSE_ERROR_FIELD]: error instanceof Error ? error.message : String(error),
      rawNode: snapshotXmlNode(node),
    };
  }
}

function snapshotXmlNode(node: XmlNode): unknown {
  return {
    element: node.name,
    attributes: { ...node.attributes },
    ...(node.text.trim() ? { text: node.text.trim() } : {}),
    ...(node.children.length > 0
      ? { children: node.children.map((child) => snapshotXmlNode(child)) }
      : {}),
  };
}

function parseCandidateFinding(node: XmlNode): unknown {
  assertElement(node, 'finding');
  assertAttributes(node, ['priority']);
  assertWhitespaceOnly(node);
  assertChildNames(node, ['target', 'related-change', 'title', 'content']);
  const target = optionalChild(node, 'target');
  const relatedChange = optionalChild(node, 'related-change');
  return {
    priority: requiredAttribute(node, 'priority'),
    ...(target ? { target: parseCandidateTarget(target) } : {}),
    ...(relatedChange ? { relatedChange: parseRelatedChange(relatedChange, false) } : {}),
    title: readTextElement(onlyChild(node, 'title')),
    content: readTextElement(onlyChild(node, 'content')),
  };
}

function parseCandidateTarget(node: XmlNode): unknown {
  assertElement(node, 'target');
  assertWhitespaceOnly(node);
  if (node.children.length !== 0) throw new Error('candidate target must be self-contained');
  const type = requiredAttribute(node, 'type');
  if (type === 'file') {
    assertAttributes(node, ['type', 'path', 'state']);
    return {
      type,
      path: requiredAttribute(node, 'path'),
      state: requiredAttribute(node, 'state'),
    };
  }
  if (type !== 'line-range') throw new Error(`Unsupported review target type: ${type}`);
  assertAttributes(node, ['type', 'path', 'side', 'start-line', 'end-line']);
  return {
    type,
    path: requiredAttribute(node, 'path'),
    side: requiredAttribute(node, 'side'),
    startLine: positiveIntegerAttribute(node, 'start-line'),
    endLine: positiveIntegerAttribute(node, 'end-line'),
  };
}

/**
 * Historical annotation-result blocks are accepted only as untrusted model
 * drafts. Runtime-owned identity, anchor, context and revision attributes are
 * intentionally discarded before the ordinary ReviewCandidate validation and
 * projection pipeline runs.
 */
function parseUntrustedAnnotationResult(root: XmlNode): unknown {
  assertAttributes(root, ['version', 'source', 'review-run-id', 'trigger', 'mode', 'verdict']);
  if (requiredAttribute(root, 'version') !== '2') {
    throw new Error('annotation-result version must be 2');
  }
  assertWhitespaceOnly(root);
  assertChildNames(root, ['summary', 'annotations']);
  const annotations = onlyChild(root, 'annotations');
  assertAttributes(annotations, []);
  assertWhitespaceOnly(annotations);
  const findings = annotations.children.map(parseUntrustedAnnotation);
  return {
    type: 'code_review_candidates',
    version: 2,
    summary: readTextElement(onlyChild(root, 'summary')),
    verdict: findings.length === 0 ? 'pass' : 'needs-changes',
    findings,
  };
}

function parseUntrustedAnnotation(node: XmlNode): unknown {
  assertElement(node, 'annotation');
  assertAttributes(node, ['id', 'kind', 'priority']);
  assertWhitespaceOnly(node);
  assertChildNames(node, ['target', 'title', 'content']);
  const parsedTarget = parseUntrustedTarget(onlyChild(node, 'target'));
  return {
    priority: requiredAttribute(node, 'priority'),
    target: parsedTarget.target,
    ...(parsedTarget.relatedChange ? { relatedChange: parsedTarget.relatedChange } : {}),
    title: readTextElement(onlyChild(node, 'title')),
    content: readTextElement(onlyChild(node, 'content')),
  };
}

function parseUntrustedTarget(node: XmlNode): { target: unknown; relatedChange?: unknown } {
  assertElement(node, 'target');
  assertWhitespaceOnly(node);
  const type = requiredAttribute(node, 'type');
  if (type !== 'file') throw new Error(`Unsupported annotation target type: ${type}`);
  assertAttributes(node, ['type', 'uri', 'state', 'blob-revision']);
  const path = requiredAttribute(node, 'uri');
  if (node.attributes.state !== undefined) {
    if (node.children.length !== 0)
      throw new Error('deleted file target must not contain selectors');
    return { target: { type: 'file', path, state: node.attributes.state } };
  }
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
  if (selector.children.length !== 0) throw new Error('annotation selector must be empty');
  if (requiredAttribute(selector, 'type') !== 'line-range') {
    throw new Error('annotation selector type must be line-range');
  }
  const relatedChange = optionalChild(node, 'related-change');
  return {
    target: {
      type: 'line-range',
      path,
      side: requiredAttribute(selector, 'side'),
      startLine: positiveIntegerAttribute(selector, 'start-line'),
      endLine: positiveIntegerAttribute(selector, 'end-line'),
    },
    ...(relatedChange ? { relatedChange: parseRelatedChange(relatedChange, true) } : {}),
  };
}

function parseRelatedChange(node: XmlNode, allowRevision: boolean): unknown {
  assertElement(node, 'related-change');
  assertAttributes(node, [
    'path',
    'side',
    'start-line',
    'end-line',
    ...(allowRevision ? ['revision'] : []),
  ]);
  assertWhitespaceOnly(node);
  if (node.children.length !== 0) throw new Error('related-change must be empty');
  return {
    path: requiredAttribute(node, 'path'),
    side: requiredAttribute(node, 'side'),
    startLine: positiveIntegerAttribute(node, 'start-line'),
    endLine: positiveIntegerAttribute(node, 'end-line'),
  };
}

function parseXmlDocument(text: string): XmlNode {
  const source = text.trim();
  if (source.length === 0) throw new Error('Review candidate XML is empty');
  if (source.length > MAX_DOCUMENT_LENGTH) throw new Error('Review candidate XML is too large');

  let root: XmlNode | undefined;
  let parseError: Error | undefined;
  let outsideText = '';
  let nodeCount = 0;
  const stack: XmlNode[] = [];
  const parser = new SaxesParser({ xmlns: false });

  parser.on('opentag', (tag) => {
    nodeCount += 1;
    if (nodeCount > MAX_NODE_COUNT) throw new Error('Review candidate XML has too many nodes');
    if (stack.length >= MAX_DEPTH) throw new Error('Review candidate XML is too deeply nested');
    const node: XmlNode = {
      name: tag.name,
      attributes: { ...tag.attributes },
      children: [],
      text: '',
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) throw new Error('Review candidate XML must contain exactly one root');
    else root = node;
    stack.push(node);
  });
  const appendText = (value: string): void => {
    const current = stack.at(-1);
    if (current) current.text += value;
    else outsideText += value;
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('doctype', () => {
    parseError ??= new Error('DOCTYPE is not allowed in Review candidate XML');
  });
  parser.on('processinginstruction', () => {
    parseError ??= new Error('Processing instructions are not allowed in Review candidate XML');
  });
  parser.on('comment', () => {
    parseError ??= new Error('Comments are not allowed in Review candidate XML');
  });
  parser.on('error', (error) => {
    parseError ??= error;
  });

  parser.write(source).close();
  if (parseError) throw parseError;
  if (!root) throw new Error('Review candidate XML root is missing');
  if (stack.length !== 0) throw new Error('Review candidate XML is not closed');
  if (outsideText.trim()) throw new Error('Text outside Review candidate XML root is not allowed');
  return root;
}

function assertElement(node: XmlNode, expected: string): void {
  if (node.name !== expected) throw new Error(`Expected <${expected}> but found <${node.name}>`);
}

function assertAttributes(node: XmlNode, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(node.attributes).find((name) => !allowedSet.has(name));
  if (unexpected) throw new Error(`Unexpected ${node.name} attribute: ${unexpected}`);
}

function requiredAttribute(node: XmlNode, name: string): string {
  const value = node.attributes[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing ${node.name} attribute: ${name}`);
  }
  return value;
}

function positiveIntegerAttribute(node: XmlNode, name: string): number {
  const raw = requiredAttribute(node, name);
  if (!/^[1-9]\d*$/u.test(raw)) throw new Error(`${node.name}.${name} must be a positive integer`);
  return Number(raw);
}

function assertWhitespaceOnly(node: XmlNode): void {
  if (node.text.trim()) throw new Error(`Unexpected text inside <${node.name}>`);
}

function assertChildNames(node: XmlNode, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = node.children.find((child) => !allowedSet.has(child.name));
  if (unexpected) throw new Error(`Unexpected <${unexpected.name}> inside <${node.name}>`);
}

function onlyChild(node: XmlNode, name: string): XmlNode {
  const matches = node.children.filter((child) => child.name === name);
  const match = matches[0];
  if (matches.length !== 1 || !match) {
    throw new Error(`<${node.name}> must contain exactly one <${name}>`);
  }
  return match;
}

function optionalChild(node: XmlNode, name: string): XmlNode | undefined {
  const matches = node.children.filter((child) => child.name === name);
  if (matches.length > 1) throw new Error(`<${node.name}> must not repeat <${name}>`);
  return matches[0];
}

function readTextElement(node: XmlNode): string {
  assertAttributes(node, []);
  if (node.children.length !== 0) throw new Error(`<${node.name}> must contain plain text only`);
  return node.text.trim();
}
