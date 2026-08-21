import { useState, useMemo } from 'react'
import { Icon } from './Icons.js'

const PAGE_SIZES = [5, 10, 20, 50, 100]

interface PaginationProps {
  page: number
  pageSize: number
  totalItems: number
  loading?: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
}

export function Pagination({ page, pageSize, totalItems, loading, onPageChange, onPageSizeChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const startItem = totalItems === 0 ? 0 : page * pageSize + 1
  const endItem = Math.min((page + 1) * pageSize, totalItems)

  const pageNumbers = useMemo(() => {
    const pages: (number | '...')[] = []
    if (totalPages <= 7) {
      for (let i = 0; i < totalPages; i++) pages.push(i)
    } else {
      pages.push(0)
      if (page > 3) pages.push('...')
      const start = Math.max(1, page - 1)
      const end = Math.min(totalPages - 2, page + 1)
      for (let i = start; i <= end; i++) pages.push(i)
      if (page < totalPages - 4) pages.push('...')
      pages.push(totalPages - 1)
    }
    return pages
  }, [page, totalPages])

  if (totalItems === 0) return null

  return (
    <div className="pagination">
      <div className="pagination-info">
        <span className="pagination-count">
          {startItem}–{endItem} of {totalItems}
        </span>
        <select
          className="field-input pagination-size"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          disabled={loading}
        >
          {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / page</option>)}
        </select>
      </div>

      <div className="pagination-pages">
        <button
          className="btn btn-ghost btn-sm pagination-nav-btn"
          onClick={() => onPageChange(0)}
          disabled={page === 0 || loading}
          title="First page"
          aria-label="First page"
        >
          <Icon name="chevron-left" size={14} /><Icon name="chevron-left" size={14} />
        </button>
        <button
          className="btn btn-ghost btn-sm pagination-nav-btn"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0 || loading}
          title="Previous page"
          aria-label="Previous page"
        >
          <Icon name="chevron-left" size={15} />
        </button>
        {pageNumbers.map((p, i) =>
          p === '...' ? (
            <span key={`dots-${i}`} className="pagination-dots">…</span>
          ) : (
            <button
              key={p}
              className={`btn btn-sm pagination-page-btn ${p === page ? 'active' : ''}`}
              onClick={() => onPageChange(p)}
              disabled={loading}
            >
              {p + 1}
            </button>
          )
        )}
        <button
          className="btn btn-ghost btn-sm pagination-nav-btn"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages - 1 || loading}
          title="Next page"
          aria-label="Next page"
        >
          <Icon name="chevron-right" size={15} />
        </button>
        <button
          className="btn btn-ghost btn-sm pagination-nav-btn"
          onClick={() => onPageChange(totalPages - 1)}
          disabled={page >= totalPages - 1 || loading}
          title="Last page"
          aria-label="Last page"
        >
          <Icon name="chevron-right" size={14} /><Icon name="chevron-right" size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Simple offset-based pagination state.
 * Stores page number and page size; consumers build query params from these.
 */
export function useOffsetPagination(defaultSize = 20) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(defaultSize)

  const offset = page * pageSize

  const goToPage = (p: number) => setPage(Math.max(0, p))
  const changeSize = (size: number) => { setPageSize(size); setPage(0) }
  const reset = () => { setPage(0); setPageSize(defaultSize) }

  return { page, pageSize, offset, goToPage, changeSize, reset }
}
