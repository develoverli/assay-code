import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type PaginationState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The table every long list in Assay uses: sorted, paged, and nothing else.
 * TanStack owns the row model; the markup stays here.
 */

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export interface DataColumn<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Providing this makes the column sortable. */
  sortValue?: (row: T) => string | number;
  /** Tailwind width class, e.g. `w-28`. */
  width?: string;
  className?: string;
}

const PAGE_SIZES = [25, 50, 100];

export function DataTable<T extends object>({
  data,
  columns,
  rowKey,
  initialSort,
  pageSize = 50,
  rowClassName,
  resetKey,
}: {
  data: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  initialSort?: { id: string; desc?: boolean };
  pageSize?: number;
  rowClassName?: (row: T) => string | undefined;
  /**
   * Changes when the caller narrows the list (a filter, a tab, another project):
   * the table goes back to page 1. A plain data refresh — a row triaged away —
   * keeps the page, only clamped to the last one that still exists.
   */
  resetKey?: string;
}) {
  const t = useT();
  const helper = React.useMemo(() => createColumnHelper<typeof features, T>(), []);

  // TanStack only needs enough of a column to sort by; the cell is ours
  const tableColumns = React.useMemo(
    () =>
      helper.columns(
        columns.map((c) =>
          helper.accessor((row: T) => (c.sortValue ? c.sortValue(row) : ""), {
            id: c.id,
            enableSorting: !!c.sortValue,
          }),
        ),
      ),
    [columns, helper],
  );

  // pagination is held here rather than inside TanStack, so the page can be
  // corrected in the same render that narrowed the list, not one frame later
  const [pagination, setPagination] = React.useState<PaginationState>({ pageIndex: 0, pageSize });
  // autoResetPageIndex stays off so a refresh of the same list keeps the page;
  // a narrowed list (a new resetKey) starts over from the first one
  const [pagedFor, setPagedFor] = React.useState(resetKey);
  if (pagedFor !== resetKey) {
    setPagedFor(resetKey);
    if (pagination.pageIndex !== 0) setPagination((p) => ({ ...p, pageIndex: 0 }));
  }
  // and a list that got shorter never points past its last page
  const lastIndex = Math.max(Math.ceil(data.length / pagination.pageSize) - 1, 0);
  const pageIndex = Math.min(pagedFor !== resetKey ? 0 : pagination.pageIndex, lastIndex);
  const size = pagination.pageSize;

  const table = useTable({
    features,
    data,
    columns: tableColumns,
    getRowId: rowKey,
    autoResetPageIndex: false,
    state: { pagination: { pageIndex, pageSize: size } },
    onPaginationChange: (updater) =>
      setPagination((cur) => {
        const from = { ...cur, pageIndex };
        return typeof updater === "function" ? updater(from) : updater;
      }),
    initialState: {
      ...(initialSort ? { sorting: [{ id: initialSort.id, desc: !!initialSort.desc }] } : {}),
    },
  });

  const rows = table.getRowModel().rows;
  const pageCount = table.getPageCount();
  const first = data.length === 0 ? 0 : pageIndex * size + 1;
  const last = Math.min((pageIndex + 1) * size, data.length);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-surface text-[11px] uppercase tracking-wide text-text-3">
          <tr>
            {columns.map((c) => {
              const column = table.getColumn(c.id);
              const sorted = column?.getIsSorted?.();
              return (
                <th key={c.id} className={cn("px-3 py-2 font-medium", c.width, c.className)}>
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => column?.toggleSorting?.()}
                      title={t("Sort by this column")}
                      className="flex cursor-pointer items-center gap-1 uppercase tracking-wide transition-colors hover:text-text-2 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {c.header}
                      {sorted === "asc" && <ArrowUp className="h-3 w-3" />}
                      {sorted === "desc" && <ArrowDown className="h-3 w-3" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={cn("border-t border-border-soft hover:bg-surface/60", rowClassName?.(row.original))}
            >
              {columns.map((c) => (
                <td key={c.id} className={cn("px-3 py-2", c.className)}>
                  {c.cell(row.original)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {data.length > PAGE_SIZES[0] && (
        <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-1.5 text-[11px] text-text-3">
          <span className="tnum">
            {t("{first}-{last} of {total}", { first, last, total: data.length })}
          </span>
          <select
            value={String(size)}
            onChange={(e) => table.setPageSize?.(Number(e.target.value))}
            aria-label={t("Rows per page")}
            className="cursor-pointer rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-2"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {t("{n} per page", { n })}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => table.previousPage?.()}
              disabled={!table.getCanPreviousPage?.()}
              aria-label={t("Previous page")}
              title={t("Previous page")}
              className="flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors enabled:cursor-pointer enabled:hover:bg-surface-2 enabled:hover:text-text disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="tnum px-1">
              {t("{page} / {pages}", { page: pageIndex + 1, pages: Math.max(pageCount, 1) })}
            </span>
            <button
              type="button"
              onClick={() => table.nextPage?.()}
              disabled={!table.getCanNextPage?.()}
              aria-label={t("Next page")}
              title={t("Next page")}
              className="flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors enabled:cursor-pointer enabled:hover:bg-surface-2 enabled:hover:text-text disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
