import type { CSSProperties } from "react";

interface SkeletonProps {
  className?: string;
  width?: string | number;
  height?: string | number;
  style?: CSSProperties;
}

/** A single shimmering placeholder block. */
export function Skeleton({ className = "", width, height, style }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className}`}
      aria-hidden="true"
      style={{ width, height, ...style }}
    />
  );
}

/** A round placeholder, useful for avatars and icon slots. */
export function SkeletonCircle({ size = 40 }: { size?: number }) {
  return <Skeleton width={size} height={size} className="skeleton-circle" />;
}

/** A document-style card with a header, meta line, and body lines. */
export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="skeleton-card">
      <div className="skeleton-card-header">
        <Skeleton width={48} height={56} />
        <div className="skeleton-card-title">
          <Skeleton width="75%" height={14} />
          <Skeleton width="55%" height={12} />
        </div>
      </div>
      <div className="skeleton-card-body">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} width={`${100 - i * 12}%`} height={12} />
        ))}
      </div>
    </div>
  );
}

/** A list of skeleton rows, useful for search results and tables. */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <Skeleton width="30%" height={12} />
          <Skeleton width={`${80 - i * 8}%`} height={12} />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

/** A table-shaped skeleton: a header row plus body rows with column gutters —
 * useful for admin and list pages that render real tables. */
export function SkeletonTable({ rows = 3, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="skeleton-table" role="status" aria-label="Loading">
      <div className="skeleton-table-header">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} width="100%" height={12} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-table-row" key={i}>
          {Array.from({ length: columns }, (_, j) => (
            <Skeleton key={j} width={j === 0 ? "65%" : "100%"} height={12} />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}
