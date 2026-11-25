import { describe, expect, it } from 'vitest';
import { refreshFilterRequests } from '../src/sheets/operations-filter.js';

const range = {
  sheetId: 7,
  startRowIndex: 0,
  endRowIndex: 2980,
  startColumnIndex: 0,
  endColumnIndex: 21,
};
const filterSpecs = [{ columnIndex: 2, filterCriteria: { hiddenValues: ['ARCHIVE'] } }];
const criteria = { '2': { hiddenValues: ['ARCHIVE'] } };
const sortSpecs = [{ dimensionIndex: 0, sortOrder: 'DESCENDING' }];

describe('refreshFilterRequests', () => {
  it('does nothing without a filter', () => {
    expect(refreshFilterRequests(undefined, 3000)).toEqual([]);
  });

  it('extends a short range, drops criteria, keeps filterSpecs', () => {
    const [req] = refreshFilterRequests({ range, criteria, filterSpecs }, 2981);
    expect(req?.setBasicFilter?.filter).toEqual({
      range: { ...range, endRowIndex: 2981 },
      filterSpecs,
    });
  });

  it('re-applies the filter even when the range already reaches the grid', () => {
    // A row written into an empty row the filter had hidden stays hidden until the filter is set again
    const [req] = refreshFilterRequests({ range, criteria, filterSpecs }, 2980);
    expect(req?.setBasicFilter?.filter).toEqual({ range, filterSpecs });
  });

  it('re-sorts rows 2..end with the same sortSpecs', () => {
    const requests = refreshFilterRequests({ range, filterSpecs, sortSpecs }, 2981);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.sortRange).toEqual({
      range: { ...range, startRowIndex: 1, endRowIndex: 2981 },
      sortSpecs,
    });
  });

  it('filters, then sorts, when the range is full', () => {
    const requests = refreshFilterRequests({ range, sortSpecs }, 2980);
    expect(requests.map((r) => Object.keys(r)[0])).toEqual(['setBasicFilter', 'sortRange']);
  });
});
