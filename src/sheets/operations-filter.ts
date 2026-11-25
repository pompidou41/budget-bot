import type { sheets_v4 } from 'googleapis';

const HEADER_ROWS = 1;

/**
 * Requests that re-apply the owner's filter and sort of «Операции» after a write. Sheets evaluates
 * a filter once: a row written into a row it hid (an empty one) stays hidden, and a sort moves only
 * visible rows — so the filter is set again every time (2026-11-25: new rows vanished), then sorted.
 */
export function refreshFilterRequests(
  filter: sheets_v4.Schema$BasicFilter | null | undefined,
  rowCount: number,
): sheets_v4.Schema$Request[] {
  const range = filter?.range;
  if (!filter || !range || range.sheetId == null) return [];
  const end = Math.max(rowCount, range.endRowIndex ?? 0);
  // The response carries both `criteria` and `filterSpecs`; only `filterSpecs` is sent (it wins)
  const { criteria: _criteria, ...rest } = filter;
  const requests: sheets_v4.Schema$Request[] = [
    { setBasicFilter: { filter: { ...rest, range: { ...range, endRowIndex: end } } } },
  ];
  const sortSpecs = filter.sortSpecs ?? [];
  if (sortSpecs.length > 0) {
    const body = { ...range, startRowIndex: HEADER_ROWS, endRowIndex: end };
    requests.push({ sortRange: { range: body, sortSpecs } });
  }
  return requests;
}
