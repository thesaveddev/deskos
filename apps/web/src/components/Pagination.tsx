import { useState } from 'react'

interface Props {
  hasMore: boolean
  onNext: () => void
  onPrev?: () => void
  loading?: boolean
}

export function Pagination({ hasMore, onNext, onPrev, loading }: Props) {
  return (
    <div className="pagination">
      <button
        className="btn btn-ghost btn-sm"
        onClick={onPrev}
        disabled={!onPrev || loading}
      >
        ← Previous
      </button>
      <button
        className="btn btn-ghost btn-sm"
        onClick={onNext}
        disabled={!hasMore || loading}
      >
        {loading ? 'Loading…' : 'Next →'}
      </button>
    </div>
  )
}

/**
 * Hook for cursor-based pagination.
 * Manages page history and cursor tracking.
 */
export function useCursorPagination() {
  const [cursors, setCursors] = useState<(string | null)[]>([null])
  const [page, setPage] = useState(0)

  const currentCursor = cursors[page] ?? null

  const goNext = (nextCursor: string | null) => {
    if (nextCursor) {
      setCursors((prev) => [...prev.slice(0, page + 1), nextCursor])
      setPage((p) => p + 1)
    }
  }

  const goPrev = () => {
    if (page > 0) setPage((p) => p - 1)
  }

  const reset = () => {
    setCursors([null])
    setPage(0)
  }

  return { cursor: currentCursor, page, goNext, goPrev, reset, canGoPrev: page > 0 }
}
