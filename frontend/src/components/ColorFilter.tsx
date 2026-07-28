import { useMemo } from 'react';

interface ColorFilterProps {
  cells: { bead_code: string | null; pixel_color?: string | null }[];
  colorMap: Record<string, string>;
  activeCode: string | null;
  onSelect: (code: string | null) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function ColorFilter({ cells, colorMap, activeCode, onSelect, collapsed = false, onToggleCollapse }: ColorFilterProps) {
  const groups = useMemo(() => {
    const map: Record<string, { count: number; color: string }> = {};
    for (const cell of cells) {
      const key = cell.bead_code || cell.pixel_color || 'default';
      if (!map[key]) map[key] = { count: 0, color: colorMap[cell.bead_code || ''] || cell.pixel_color || '#ccc' };
      map[key].count++;
    }
    const entries = Object.entries(map)
      .filter(([k]) => k !== 'default')
      .map(([code, info]) => ({ code, ...info }));
    entries.sort((a, b) => b.count - a.count);
    return entries;
  }, [cells, colorMap]);

  if (collapsed && onToggleCollapse) {
    return (
      <div
        className="flex items-center gap-2 px-4 py-2"
        style={{
          background: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <button
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
          style={{
            background: 'var(--color-accent-light)',
            color: 'var(--color-accent)',
            boxShadow: '0 0 0 2px var(--color-accent)',
          }}
        >
          <span>🎨</span>
          <span>{groups.length} 色</span>
          <span>▾</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-2 p-2 overflow-x-auto"
      style={{
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <button
        onClick={() => onSelect(null)}
        className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
        style={{
          background: !activeCode ? 'var(--color-accent-light)' : 'var(--color-bg-secondary)',
          color: !activeCode ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          boxShadow: !activeCode ? '0 0 0 2px var(--color-accent)' : 'none',
        }}
      >
        全部显示
      </button>
      {groups.map(({ code, count, color }) => (
        <button
          key={code}
          onClick={() => onSelect(activeCode === code ? null : code)}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{
            background: activeCode === code ? 'var(--color-accent-light)' : 'var(--color-bg-secondary)',
            boxShadow: activeCode === code ? '0 0 0 2px var(--color-accent)' : 'none',
            color: activeCode === code ? 'var(--color-accent)' : 'var(--color-text)',
          }}
        >
          <span
            className="w-3 h-3 rounded-full"
            style={{
              backgroundColor: color,
              border: '1px solid var(--color-border-strong)',
            }}
          />
          {code.length <= 6 ? code : code.slice(0, 6)}
          <span style={{ color: 'var(--color-text-muted)' }}>({count})</span>
        </button>
      ))}
    </div>
  );
}
