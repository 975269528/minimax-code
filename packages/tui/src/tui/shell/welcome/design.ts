export const MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT = '{paste-image-shortcut}';
const MINIMAX_CODE_WELCOME_CHECKIN_TIP = '/checkin claims the daily reward.';

export const MINIMAX_CODE_WELCOME_DESIGN = {
  sectionTitles: {
    tips: 'Tips for getting started',
    news: "What's new · /changelog for history",
  },
  tipPool: [
    'Say what you want and how to verify it.',
    `Use @ for files; ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} for images.`,
    'Run /init to teach MCode this repo.',
    'Use /plan before a change that needs design or investigation.',
    'Use /context to check the current Session context budget.',
    'Use /sessions to resume earlier work.',
    'Use /history to review and branch from earlier prompts.',
    'Use /goal to keep long-running work focused on a finish line.',
    'Use /permission to choose how MCode handles tool approvals.',
    'Use /feedback to preview a redacted report before upload.',
    MINIMAX_CODE_WELCOME_CHECKIN_TIP,
  ],
  wide: {
    tips: [
      'Say what you want and how to verify it.',
      `Use @ for files; ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} for images.`,
      'Run /init to teach MCode this repo.',
      MINIMAX_CODE_WELCOME_CHECKIN_TIP,
    ],
    news: [
      'Send follow-ups while MCode works.',
      '/context shows read-only session context.',
      '/feedback previews before upload.',
    ],
  },
  stacked: {
    tips: [
      'Say what you want and how to verify it.',
      `@ files · ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} images · /init guidance`,
      '/checkin daily reward',
    ],
    news: ['Follow-ups wait while MCode works.', '/context budget · /feedback preview'],
  },
  compact: {
    tips: [
      `@ files · ${MINIMAX_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} images`,
      '/init repo guidance',
      '/checkin reward',
    ],
    news: ['Follow-ups wait', '/context · /feedback'],
  },
  hero: {
    fullMinWidth: 91,
    mediumMinWidth: 44,
    microMinWidth: 11,
    fallbackTitle: 'M',
  },
} as const;

export const MINIMAX_CODE_TERMINAL_WORDMARK = [
  '███╗   ███╗██╗███╗   ██╗██╗███╗   ███╗ █████╗ ██╗  ██╗     ██████╗ ██████╗ ██████╗ ███████╗',
  '████╗ ████║██║████╗  ██║██║████╗ ████║██╔══██╗╚██╗██╔╝    ██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██╔████╔██║██║██╔██╗ ██║██║██╔████╔██║███████║ ╚███╔╝     ██║     ██║   ██║██║  ██║█████╗',
  '██║╚██╔╝██║██║██║╚██╗██║██║██║╚██╔╝██║██╔══██║ ██╔██╗     ██║     ██║   ██║██║  ██║██╔══╝',
  '██║ ╚═╝ ██║██║██║ ╚████║██║██║ ╚═╝ ██║██║  ██║██╔╝ ██╗    ╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
] as const;

export const MINIMAX_CODE_TERMINAL_MEDIUM_WORDMARK = [
  '███╗   ███╗ ██████╗ ██████╗ ██████╗ ███████╗',
  '████╗ ████║██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██╔████╔██║██║     ██║   ██║██║  ██║█████╗',
  '██║╚██╔╝██║██║     ██║   ██║██║  ██║██╔══╝',
  '██║ ╚═╝ ██║╚██████╗╚██████╔╝██████╔╝███████╗',
  '╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
] as const;

export const MINIMAX_CODE_TERMINAL_MICRO_WORDMARK = [
  '███╗   ███╗',
  '████╗ ████║',
  '██╔████╔██║',
  '██║╚██╔╝██║',
  '██║ ╚═╝ ██║',
  '╚═╝     ╚═╝',
] as const;
