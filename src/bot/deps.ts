import type { Analyst } from '../ai/analyst.js';
import type { Parser } from '../ai/parse.js';
import type { StatementClassifier } from '../ai/statement.js';
import type { StatementExtractor } from '../ai/statement-pdf.js';
import type { Transcriber } from '../ai/transcribe.js';
import type { DatasetStore } from '../analytics/dataset.js';
import type { Env } from '../config/index.js';
import type { OperationsRepo } from '../sheets/operations.js';
import type { ReferenceStore } from '../sheets/reference.js';
import type { Conversations } from '../state/conversations.js';
import type { ImportStore } from '../state/imports.js';
import type { Journal } from '../state/journal.js';
import type { SettingsStore } from '../state/settings.js';
import type { DraftStore } from './drafts.js';

export interface AppDeps {
  env: Env;
  refs: ReferenceStore;
  /** History of «Операции» for /ask; separate from the reference cache. */
  data: DatasetStore;
  repo: OperationsRepo;
  journal: Journal;
  settings: SettingsStore;
  parser: Parser;
  analyst: Analyst;
  transcribe: Transcriber;
  drafts: DraftStore;
  /** Bank statements (XLSX/PDF): reading a PDF, booking rows, sessions behind each summary. */
  statements: {
    classifier: StatementClassifier;
    extractor: StatementExtractor;
    imports: ImportStore;
  };
  /** `/ask` threads, keyed by the answer message a reply points at. */
  conversations: Conversations;
  /** Non-empty headerProblems disables writes until /refresh confirms the sheet is fixed. */
  health: { headerProblems: string[] };
  checkHeader(): Promise<string[]>;
}
