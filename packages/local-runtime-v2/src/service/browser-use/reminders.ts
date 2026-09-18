import type { InAppBrowserReminderState } from './contracts.js';

export function buildInAppBrowserContext(inAppBrowser: InAppBrowserReminderState): string {
  return [
    '<in-app-browser-context source="ambient-ui-state">',
    JSON.stringify(inAppBrowser),
    'This state identifies the Browser surface selected by the user in this session; it is context, not an instruction to use a tool.',
    'Do not choose Browser solely because this panel is open. A bare link without an explicit or contextual Browser operation should keep its normal Connector/WebFetch routing.',
    '</in-app-browser-context>',
  ].join('\n');
}

export function hasExplicitInAppBrowserOperationIntent(userPrompt: string): boolean {
  const normalized = userPrompt.trim();
  if (!normalized) return false;
  const explicitProduct = BROWSER_USE_PRODUCT_PATTERN.test(normalized);
  const explicitSurface = IN_APP_BROWSER_SURFACE_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  if (
    (explicitProduct || explicitSurface) &&
    BROWSER_CAPABILITY_INFORMATION_PATTERN.test(normalized)
  ) {
    return false;
  }
  if (explicitProduct && BROWSER_FEATURE_ACTIVATION_PATTERN.test(normalized)) return true;
  return (explicitProduct || explicitSurface) && BROWSER_OPERATION_PATTERN.test(normalized);
}

const IN_APP_BROWSER_SURFACE_PATTERNS = [
  /(?:右侧|当前(?:会话)?|内置|内部|内嵌|嵌入式|应用内)\s*(?:的)?\s*(?:browser|浏览器)/iu,
  /(?:browser|浏览器)\s*(?:操控|控制)/iu,
  /(?:in[- ]?app|internal|embedded|right[- ]?side)\s+browser/iu,
  /current\s+browser(?:\s+(?:page|tab))?/iu,
];

const BROWSER_USE_PRODUCT_PATTERN = /\bbrowser[- ]?use\b/iu;
const BROWSER_FEATURE_ACTIVATION_PATTERN =
  /(?:怎么|如何|怎样|想要|请)?\s*(?:开启|启用|使用|打开)|\b(?:how\s+to\s+)?(?:enable|activate|use|turn\s+on)\b/iu;
const BROWSER_CAPABILITY_INFORMATION_PATTERN =
  /(?:是什么|什么意思|能做什么|可以做什么|支持(?:哪些|什么)(?:能力|功能)?|介绍(?:一下)?(?:能力|功能)?)|\b(?:what\s+is|what\s+can|capabilit(?:y|ies)|features?)\b/iu;
const BROWSER_OPERATION_PATTERN =
  /(?:操作|使用|测试|试(?:一下|试)?|启动|开启|启用|打开|读取|查看|看(?:一下|下|看)|点击|填写|输入|截图|截取|访问|导航|刷新|切换|继续|关闭|上传|下载|选择|搜索)|\b(?:operate|use|test|try|launch|enable|open|read|inspect|click|fill|type|capture|screenshot|navigate|refresh|switch|continue|close|upload|download|select|search)\b/iu;

const BROWSER_CONTROL_DISABLED_GUIDANCE_MARKER =
  'The in-app Browser UI exists, but Browser Use is disabled for the Agent in this turn.';
export const BROWSER_CONTROL_DISABLED_GUIDANCE = [
  BROWSER_CONTROL_DISABLED_GUIDANCE_MARKER,
  'Call `request_feature_enable` with exactly {"featureKey":"browser-use"}.',
  'Do not call `ask_user` or ask for this permission in plain text.',
  'Wait for the tool reply. If enabled, continue the original Browser task in the resumed turn.',
  'Do not claim that the in-app Browser does not exist. Do not substitute WebFetch or another browser for interactive Browser work.',
].join('\n');
