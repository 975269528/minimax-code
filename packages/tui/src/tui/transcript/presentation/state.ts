import {
  resolveTranscriptCellDisplayMode,
  type TranscriptCell,
  type TranscriptDisplayMode,
} from '../model.js';

export type TranscriptMainMode = 'compact' | 'detailed';

export interface TranscriptDisplayModeResolver {
  readonly revision: number;
  resolveMainDisplayMode(cell: TranscriptCell): TranscriptDisplayMode;
  toggleMainMode?(): TranscriptMainMode;
}

export class TranscriptPresentationController implements TranscriptDisplayModeResolver {
  private mode: TranscriptMainMode = 'compact';
  private revisionValue = 0;

  get revision(): number {
    return this.revisionValue;
  }

  get mainMode(): TranscriptMainMode {
    return this.mode;
  }

  setMainMode(mode: TranscriptMainMode): TranscriptMainMode {
    if (this.mode === mode) return this.mode;
    this.mode = mode;
    this.revisionValue += 1;
    return this.mode;
  }

  toggleMainMode(): TranscriptMainMode {
    return this.setMainMode(this.mode === 'compact' ? 'detailed' : 'compact');
  }

  resolveMainDisplayMode(cell: TranscriptCell): TranscriptDisplayMode {
    if (this.mode === 'detailed' && isExpandableCell(cell)) return 'expanded';
    if (cell.kind === 'tool') return 'collapsed';
    if (cell.kind === 'thinking') {
      return cell.status === 'pending' || cell.status === 'running' ? 'preview' : 'collapsed';
    }
    return resolveTranscriptCellDisplayMode(cell);
  }
}

function isExpandableCell(cell: TranscriptCell): boolean {
  return cell.kind === 'thinking' || cell.kind === 'tool' || cell.kind === 'diff';
}
