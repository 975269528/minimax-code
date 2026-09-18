import type {
  AskQuestionStep,
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';
import { translateRuntimeText } from '@mavis/shared/runtime-i18n';

export function serializeQuestionnaireAsk(request: AskQuestionnaireRequest): string {
  const lines = [
    '<questionnaire-ask>',
    `  <requestId>${escapeXml(request.id)}</requestId>`,
    `  <schemaVersion>${request.schemaVersion}</schemaVersion>`,
  ];
  if (request.title) lines.push(`  <title>${escapeXml(request.title)}</title>`);
  lines.push('  <steps>');
  for (const step of request.steps) lines.push(serializeStep(step));
  lines.push('  </steps>');
  lines.push('</questionnaire-ask>');
  return lines.join('\n');
}

export function serializeMinimalQuestionnaireAsk(requestId: string): string {
  return [
    '<questionnaire-ask>',
    `  <requestId>${escapeXml(requestId)}</requestId>`,
    '</questionnaire-ask>',
  ].join('\n');
}

export interface QuestionnaireAskBlockMatch {
  block: string;
  start: number;
  end: number;
  requestId?: string;
}

export function findQuestionnaireAskBlockOutsideMarkdownCode(
  xml: string,
): QuestionnaireAskBlockMatch | undefined {
  const codeRanges = collectMarkdownCodeRanges(xml);
  const rootRegex = /<questionnaire-ask>[\s\S]*?<\/questionnaire-ask>/g;
  for (const match of xml.matchAll(rootRegex)) {
    const start = match.index ?? 0;
    if (codeRanges.some((range) => start >= range.start && start < range.end)) continue;
    const block = match[0];
    return {
      block,
      start,
      end: start + block.length,
      requestId: extractElement(block, 'requestId'),
    };
  }
  return undefined;
}

export function extractQuestionnaireRequestIdFromXml(xml: string): string | undefined {
  return findQuestionnaireAskBlockOutsideMarkdownCode(xml)?.requestId;
}

export function serializeQuestionnaireResponse(
  payload: AskQuestionnaireReplyPayload,
  request?: AskQuestionnaireRequest,
): string {
  const lines = [
    '<questionnaire-response>',
    `  <requestId>${escapeXml(payload.requestId)}</requestId>`,
    `  <schemaVersion>${payload.schemaVersion}</schemaVersion>`,
    `  <submittedAt>${payload.submittedAt}</submittedAt>`,
  ];
  if (request?.mode) lines.push(`  <mode>${escapeXml(request.mode)}</mode>`);
  if (payload.source) {
    lines.push(`  <responseSource>${escapeXml(payload.source)}</responseSource>`);
    lines.push(
      `  <explicitUserConfirmation>${payload.source === 'user' ? 'true' : 'false'}</explicitUserConfirmation>`,
    );
  }
  if (request?.mode === 'feature-enable' && request.modePayload?.featureKey) {
    lines.push(`  <featureKey>${escapeXml(request.modePayload.featureKey)}</featureKey>`);
  }
  lines.push('  <answers>');
  for (const answer of payload.answers) lines.push(serializeAnswer(answer));
  lines.push('  </answers>');
  lines.push('</questionnaire-response>');
  return lines.join('\n');
}

export function serializeQuestionnaireResponseMessage(
  request: AskQuestionnaireRequest,
  reply: AskQuestionnaireReplyPayload,
  locale?: string,
): string {
  const response = serializeQuestionnaireResponse(reply, request);
  return request.mode === 'feature-enable'
    ? response
    : `${response}\n\n${formatAnswersAsText(request, reply.answers, locale)}`;
}

export function formatAnswersAsText(
  request: AskQuestionnaireRequest,
  answers: AskQuestionnaireReplyAnswer[],
  locale?: string,
): string {
  const noAnswer = translateRuntimeText(locale, 'questionnaire.noAnswer');
  const others = translateRuntimeText(locale, 'questionnaire.others');
  const stepById = new Map(request.steps.map((step) => [step.id, step]));
  const blocks: string[] = [];
  for (const answer of answers) {
    const step = stepById.get(answer.stepId);
    if (!step) continue;
    const optionLabel = (optionId: string): string =>
      step.options.find((option) => option.id === optionId)?.label ?? optionId;
    const questionLine = `Q: ${escapeMarkdown(step.question)}`;
    let answerLine: string;
    if (answer.skipped) {
      answerLine = `A: ${noAnswer}`;
    } else {
      const parts = answer.selectedOptionIds.map((id) => escapeMarkdown(optionLabel(id)));
      if (answer.selectedOther && answer.otherText) {
        parts.push(`${others}: ${escapeMarkdown(answer.otherText)}`);
      }
      answerLine = `A: ${parts.length > 0 ? parts.join(', ') : noAnswer}`;
    }
    blocks.push(`${questionLine}  \n${answerLine}`);
  }
  return blocks.join('\n\n');
}

function serializeStep(step: AskQuestionStep): string {
  const lines = ['  <step>'];
  lines.push(`    <id>${escapeXml(step.id)}</id>`);
  if (step.header) lines.push(`    <header>${escapeXml(step.header)}</header>`);
  lines.push(`    <question>${escapeXml(step.question)}</question>`);
  if (step.description) lines.push(`    <description>${escapeXml(step.description)}</description>`);
  lines.push(`    <selectionMode>${escapeXml(step.selectionMode)}</selectionMode>`);
  if (step.image) lines.push(`    <image src="${escapeXml(step.image.src)}" />`);
  if (step.options.length > 0) {
    lines.push('    <options>');
    for (const option of step.options) {
      const desc = option.description ? ` description="${escapeXml(option.description)}"` : '';
      const imageAttrs = option.image
        ? ` imageSrc="${escapeXml(option.image.src)}"${
            option.image.alt ? ` imageAlt="${escapeXml(option.image.alt)}"` : ''
          }`
        : '';
      lines.push(
        `      <option id="${escapeXml(option.id)}"${desc}${imageAttrs}>${escapeXml(option.label)}</option>`,
      );
    }
    lines.push('    </options>');
  }
  lines.push('  </step>');
  return lines.join('\n');
}

function serializeAnswer(answer: AskQuestionnaireReplyAnswer): string {
  const lines = ['  <answer>'];
  lines.push(`    <stepId>${escapeXml(answer.stepId)}</stepId>`);
  if (answer.skipped) {
    lines.push('    <skipped>true</skipped>');
    lines.push('  </answer>');
    return lines.join('\n');
  }
  if (answer.selectedOptionIds.length > 0) {
    lines.push('    <selectedOptions>');
    for (const id of answer.selectedOptionIds) lines.push(`      <item>${escapeXml(id)}</item>`);
    lines.push('    </selectedOptions>');
  }
  if (answer.selectedOther) {
    lines.push('    <selectedOther>true</selectedOther>');
    if (answer.otherText) lines.push(`    <otherText>${escapeXml(answer.otherText)}</otherText>`);
  }
  lines.push('  </answer>');
  return lines.join('\n');
}

function extractElement(xml: string, tagName: string): string | undefined {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`);
  const match = regex.exec(xml);
  if (!match) return undefined;
  return unescapeXml((match[1] ?? '').trim());
}

function collectMarkdownCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const codeRegex = /```[\s\S]*?```|`[^`]*`/g;
  for (const match of text.matchAll(codeRegex)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[~])/g, '\\$1');
}
