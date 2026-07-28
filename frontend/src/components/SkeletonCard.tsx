export default function SkeletonCard() {
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: 'var(--color-surface)',
        boxShadow: 'var(--shadow-sm)',
        border: '1px solid var(--color-border)',
      }}
    >
      <div
        className="h-32 skeleton-shimmer"
        style={{ background: 'var(--color-bg-secondary)' }}
      />
      <div className="p-3 space-y-2">
        <div
          className="h-4 rounded w-3/4 skeleton-shimmer"
          style={{ background: 'var(--color-bg-secondary)' }}
        />
        <div
          className="h-3 rounded w-1/2 skeleton-shimmer"
          style={{ background: 'var(--color-bg-secondary)' }}
        />
      </div>
    </div>
  );
}
