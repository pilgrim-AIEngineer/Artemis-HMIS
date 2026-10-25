import {
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
} from '@tanstack/react-table';

/**
 * TanStack Table v9: one stable feature set for the masters screens. Sorting works on the rows
 * already loaded (the server orders and pages; docs/02 §7); nothing else is needed.
 */
export const masterTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
