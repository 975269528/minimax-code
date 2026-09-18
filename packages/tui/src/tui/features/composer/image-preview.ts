import type { TuiTransportAttachment } from '../../../types/invocation.js';
import { loadTuiImagePreview, type TuiImagePreviewData } from '../../../host/image-preview.js';
import { getCapabilities, Image } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import type { Editor } from '../../widgets/editor/editor.js';
import { formatBytes } from './attachments.js';
import { composerText } from './copy.js';

interface PreviewEntry {
  readonly key: string;
  readonly abort: AbortController;
  data?: TuiImagePreviewData;
  settled: boolean;
  image?: Image;
  imageLayout?: string;
}

type PreviewAttachment = Pick<
  TuiTransportAttachment,
  'type' | 'fileName' | 'mimeType' | 'filePath' | 'sizeBytes'
> & {
  readonly id?: string;
};

/** A transient composer view. Loading or decode failure never changes the draft. */
export class TuiComposerImagePreview implements Component {
  private entry: PreviewEntry | undefined;
  private disposed = false;
  private attachments: () => readonly PreviewAttachment[] = () => [];

  constructor(
    private readonly options: {
      readonly editor: Pick<Editor, 'getAttachmentPreview'>;
      readonly terminalRows: () => number;
      readonly requestRender: () => void;
      readonly load?: typeof loadTuiImagePreview;
    },
  ) {}

  setAttachmentSource(source: () => readonly PreviewAttachment[]): void {
    this.attachments = source;
  }

  invalidate(): void {
    this.entry?.image?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    this.entry?.abort.abort();
    this.entry = undefined;
  }

  render(width: number): string[] {
    const selection = this.options.editor.getAttachmentPreview();
    const attachment =
      selection &&
      this.attachments().find(
        (item) => (item.id ?? item.filePath) === selection.id && item.type === 'image',
      );
    if (this.disposed || !selection || !attachment || width < 12) {
      this.clear();
      return [];
    }
    const key = JSON.stringify([
      selection.id,
      attachment.filePath,
      attachment.mimeType,
      attachment.sizeBytes,
    ]);
    if (this.entry?.key !== key) {
      this.clear();
      const entry: PreviewEntry = { key, abort: new AbortController(), settled: false };
      this.entry = entry;
      const loading = attachment.filePath
        ? (this.options.load ?? loadTuiImagePreview)(
            attachment.filePath,
            sanitizeTerminalText(attachment.mimeType),
            entry.abort.signal,
          )
        : Promise.resolve({});
      void loading
        .then((data) => {
          entry.data = data;
        })
        .catch(() => {
          entry.data = {};
        })
        .finally(() => {
          entry.settled = true;
          if (!this.disposed && this.entry === entry) this.options.requestRender();
        });
    }
    const entry = this.entry;
    if (!entry) return [];
    const line = (text: string): string => truncateToWidth(text, width, '…');
    const dimensions = entry.data?.dimensions;
    const meta = [
      sanitizeTerminalText(attachment.mimeType),
      ...(dimensions ? [`${dimensions.widthPx} × ${dimensions.heightPx}`] : []),
      ...(attachment.sizeBytes === undefined ? [] : [formatBytes(attachment.sizeBytes)]),
      sanitizeTerminalText(attachment.fileName),
    ].join(' · ');
    const lines = [
      line(chalk.hex(colors.signal)(sanitizeTerminalText(selection.label))),
      line(chalk.hex(colors.muted)(meta)),
    ];
    // Keep enough room for the actual editor and status, including short terminals.
    const availableRows = Math.max(0, Math.floor(this.options.terminalRows()) - 12);
    const imageRows = Math.min(6, availableRows);
    const protocol = getCapabilities().images;
    if (entry.data?.png && protocol && imageRows >= 2) {
      const layout = `${protocol}:${imageRows}`;
      if (!entry.image || entry.imageLayout !== layout) {
        entry.image = new Image(
          entry.data.png,
          'image/png',
          {
            fallbackColor: (text) => chalk.hex(colors.muted)(text),
          },
          { maxWidthCells: 56, maxHeightCells: imageRows },
        );
        entry.imageLayout = layout;
      }
      lines.push(...entry.image.render(width));
    } else {
      const message = !entry.settled
        ? 'imagePreviewLoading'
        : !entry.data?.png
          ? 'imagePreviewUnavailable'
          : 'imagePreviewTextOnly';
      lines.push(line(chalk.hex(colors.muted)(composerText(message))));
    }
    lines.push(line(chalk.hex(colors.dim)(composerText('imagePreviewHint'))));
    return lines;
  }
}
