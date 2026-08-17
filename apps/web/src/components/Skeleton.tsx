/** Reusable loading skeleton — renders animated placeholder blocks. */
export function Skeleton({ lines = 3, style }: { lines?: number; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, ...style }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          style={{
            height: 14,
            borderRadius: 4,
            background: 'linear-gradient(90deg, var(--bg-2) 25%, var(--line-1) 50%, var(--bg-2) 75%)',
            backgroundSize: '200% 100%',
            animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
            width: i === lines - 1 ? '60%' : '100%',
          }}
        />
      ))}
    </div>
  )
}

/** Stat card skeleton — placeholder for stat rows. */
export function StatSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="stat-row" aria-busy="true" aria-label="Loading stats">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat-card">
          <div style={{ height: 28, width: 60, borderRadius: 4, background: 'var(--bg-2)', marginBottom: 6 }} />
          <div style={{ height: 12, width: 80, borderRadius: 4, background: 'var(--bg-2)' }} />
        </div>
      ))}
    </div>
  )
}

/** Table skeleton — placeholder for table rows. */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="queue-table" aria-busy="true" aria-label="Loading table">
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12, padding: '10px 12px', background: 'var(--bg-2)' }}>
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} style={{ height: 10, borderRadius: 3, background: 'var(--line-1)', width: '70%' }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12, padding: '12px 12px', borderBottom: '1px solid var(--line-1)' }}>
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} style={{ height: 12, borderRadius: 3, background: 'var(--bg-2)', width: `${60 + Math.random() * 30}%` }} />
          ))}
        </div>
      ))}
    </div>
  )
}
