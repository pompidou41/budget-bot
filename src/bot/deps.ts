import type { Analyst } from '../ai/analyst.js';
import type { Parser } from '../ai/parse.js';
import type { Transcriber } from '../ai/transcribe.js';
import type { DatasetStore } from '../analytics/dataset.js';
import type { Env } from '../config/index.js';
import type { OperationsRepo } from '../sheets/operations.js';
import type { ReferenceStore } from '../sheets/reference.js';
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
  /** Non-empty headerProblems disables writes until /refresh confirms the sheet is fixed. */
  health: { headerProblems: string[] };
  checkHeader(): Promise<string[]>;
}
