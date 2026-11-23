import { cellToIso } from '../analytics/dataset.js';
import { renderCard } from '../domain/card.js';
import { formatDateRu } from '../domain/dates.js';
import { escapeHtml, formatAmount } from '../domain/format.js';
import { parseEntry } from '../domain/last.js';
import type { Reference } from '../domain/reference.js';
import type { RemoveResult } from '../sheets/operations.js';

export const KEPT_TEXT = '👌 Оставил в таблице — ничего не удалено.';

export const NOT_FOUND_TEXT =
  '⚠️ Не нашёл эту запись в таблице такой, как я её записал (строку изменили вручную, ' +
  'она уже удалена или таких строк несколько). Ничего не удалил — если нужно, удали строку в таблице сам.';

/** One line for a raw sheet row: date · type · account · amount · comment. */
export function describeCells(cells: unknown[]): string {
  const date = cellToIso(cells[0]);
  const parts = [
    date ? formatDateRu(date) : '',
    String(cells[1] ?? ''),
    String(cells[2] ?? ''),
    typeof cells[3] === 'number' ? formatAmount(cells[3]) : '',
    String(cells[8] ?? ''),
  ].filter(Boolean);
  return escapeHtml(parts.join(' · '));
}

/** The operation as the sheet holds it right now, with the row number. */
export function liveCard(cells: unknown[], row: number, ref: Reference, footer: string): string {
  const entry = parseEntry(cells, row);
  if (!entry) return `Строка ${row}: ${describeCells(cells)}\n\n${footer}`;
  return renderCard(entry.op, ref, { footer });
}

/** Plain-Russian warning when a deletion did not go as asked; null when nothing odd happened. */
export function raceNotice(result: RemoveResult): string | null {
  if (result.collateral.length === 0 && result.stillPresent.length === 0) return null;
  const lines = ['⚠️ Пока я удалял, таблицу пересортировали.'];
  for (const { cells, restoredTo } of result.collateral) {
    lines.push(
      restoredTo === null
        ? `Случайно задетую строку (${describeCells(cells)}) вернуть не вышло — внеси её вручную.`
        : `Случайно задетую строку (${describeCells(cells)}) вернул, теперь она в строке ${restoredTo}.`,
    );
  }
  if (result.stillPresent.length > 0) lines.push('Нужная строка не удалена — попробуй ещё раз.');
  return lines.join('\n');
}
