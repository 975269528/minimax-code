/**
 * mavis-widget DSL types — shared contract between daemon (persistence)
 * and UI (parsing + rendering).
 */

export type MavisWidgetKind =
  | 'chart'
  | 'map'
  | 'dashboard'
  | 'diagram'
  | 'interactive'
  | 'form'
  | 'mockup';

export type MavisWidgetStreamingMode = 'html-first' | 'complete' | 'static';

export type MavisWidgetThemeMode = 'app' | 'light' | 'dark' | 'isolated';

export type MavisWidgetCapability =
  | 'resize'
  | 'sendPrompt'
  | 'openLink'
  | 'download'
  | 'submitForm';

export type MavisWidgetPolicy = 'local-only' | 'inline-only' | 'trusted-cdn';

export interface MavisWidgetData {
  name: string;
  type: string;
  content: string;
}

export interface MavisWidgetEnvelope {
  version: string;
  kind: MavisWidgetKind;
  title: string;
  id?: string;
  height?: number;
  minHeight?: number;
  maxHeight?: number;
  streaming: MavisWidgetStreamingMode;
  capabilities?: MavisWidgetCapability[];
  theme?: MavisWidgetThemeMode;
  tokenSet?: string;
  policy?: MavisWidgetPolicy;

  meta?: string;
  style?: string;
  html?: string;
  data?: MavisWidgetData[];
  script?: string;
  fallback?: string;
}

export type WidgetContentSegment =
  | { type: 'text'; content: string }
  | { type: 'widget'; envelope: MavisWidgetEnvelope }
  | { type: 'widget_incomplete'; raw: string };
