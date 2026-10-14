import type { DatasetStore } from '../analytics/dataset.js';
import type { Answer } from '../domain/answer.js';
import type { ReferenceStore } from '../sheets/reference.js';
import type { SettingsStore } from '../state/settings.js';
import type { Analyst, AnalystTurn } from './analyst.js';

/** What the finance Q&A needs; the Telegram handler and the internal API both provide it. */
export interface AskDeps {
  refs: ReferenceStore;
  data: DatasetStore;
  settings: SettingsStore;
  analyst: Analyst;
}

/**
 * The core of `/ask` without any transport: loads reference data and history, asks the analyst.
 * Returns `null` when «Операции» has no rows to analyse, so each caller words that its own way.
 */
export async function askFinance(
  deps: AskDeps,
  question: string,
  history: AnalystTurn[] = [],
): Promise<Answer | null> {
  const [ref, txns] = await Promise.all([deps.refs.get(), deps.data.get()]);
  if (txns.length === 0) return null;

  return deps.analyst.ask({
    question,
    ref,
    txns,
    notes: deps.settings.get().notes,
    history,
  });
}
