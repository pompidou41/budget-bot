import type { sheets_v4 } from 'googleapis';

const HEADER_ROWS = 1;

/**
 * Requests that re-apply the owner's sort of «Операции» after a write (Sheets sorts once, so a new
 * row stays where it was written) and stretch a too-short filter range to the grid.
 */
export function refreshFilterRequests(
  filter: sheets_v4.Schema$BasicFilter | null | undefined,
  rowCount: number,
): sheets_v4.Schema$Request[] {
  const range = filter?.range;
  if (!filter || !range || range.sheetId == null) return [];
  const end = Math.max(rowCount, range.endRowIndex ?? 0);
  const requests: sheets_v4.Schema$Request[] = [];
  if ((range.endRowIndex ?? 0) < end) {
    // The response carries both `criteria` and `filterSpecs`; only `filterSpecs` is sent (it wins)
    const { criteria: _criteria, ...rest } = filter;
    requests.push({
      setBasicFilter: { filter: { ...rest, range: { ...range, endRowIndex: end } } },
    });
  }
  const sortSpecs = filter.sortSpecs ?? [];
  if (sortSpecs.length > 0) {
    const body = { ...range, startRowIndex: HEADER_ROWS, endRowIndex: end };
    requests.push({ sortRange: { range: body, sortSpecs } });
  }
  return requests;
}
