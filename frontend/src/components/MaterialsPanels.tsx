import { memo, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent } from 'react';
import Button from './Button';
import type { GridCell } from '../hooks/useMaterialsCapture';
import { compareMaterialCodes, isGridFailure, normalizeMaterialCode } from '../hooks/useMaterialsCapture';

const field: CSSProperties = {
  width: '100%',
  height: 36,
  padding: '0 8px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-bg-primary)',
  fontSize: 16,
  color: 'var(--color-text)',
};

interface GridPanelProps {
  grid: GridCell[];
  onChange: (index: number, field: 'code' | 'count', value: string) => void;
  onAddManual: () => void;
  onRetry: (index: number) => void;
  onDelete: (index: number) => void;
  onToggleConfirmed: (index: number, confirmed: boolean) => void;
  onClear: () => void;
  onJump: (cell: GridCell) => void;
  onReject: (code: string) => void;
  autoFocusId?: string | null;
  loading: boolean;
}

export const GridPanel = memo(function GridPanel({
  grid,
  onChange,
  onAddManual,
  onRetry,
  onDelete,
  onToggleConfirmed,
  onClear,
  onJump,
  onReject,
  autoFocusId,
  loading,
}: GridPanelProps) {
  // 编码编辑采用草稿：只在“焦点离开该卡片”（编码/数量/确认/删除等都不再激活）
  // 时才提交编码，因此编辑过程中排序依据仍是旧编码，卡片不会跳动。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 按确认状态筛选（只影响显示，不改数据）
  const [filter, setFilter] = useState<'all' | 'confirmed' | 'unconfirmed'>('all');
  const autoFocusHandledRef = useRef<string | null>(null);

  useEffect(() => {
    if (autoFocusId == null || autoFocusHandledRef.current === autoFocusId) return;
    autoFocusHandledRef.current = autoFocusId;
    const input = document.getElementById(`grid-code-${autoFocusId}`);
    if (input) {
      input.focus();
      if (typeof (input as HTMLInputElement).select === 'function') (input as HTMLInputElement).select();
    }
  }, [autoFocusId]);

  const commitCell = (identity: string) => {
    const draft = drafts[identity];
    const gridIndex = grid.findIndex((c) => (c.sourceId ?? `${c.row}-${c.col}`) === identity);
    setDrafts((d) => {
      const next = { ...d };
      delete next[identity];
      return next;
    });
    if (draft == null) return;
    const cell = grid[gridIndex];
    if (!cell) return;
    const value = draft.toUpperCase();
    const normalized = normalizeMaterialCode(value);
    const duplicate = normalized.length > 0
      && grid.some((other, otherIndex) => otherIndex !== gridIndex && normalizeMaterialCode(other.code) === normalized);
    if (duplicate) {
      onReject(normalized);
    } else if (value !== cell.code) {
      onChange(gridIndex, 'code', value);
    }
  };

  // 焦点在同一张卡片内移动（编码 → 数量）时不提交；
  // 一旦焦点离开该卡片才提交草稿并让列表按新编码重排。
  const handleFieldBlur = (event: FocusEvent<HTMLInputElement>, identity: string) => {
    const related = event.relatedTarget as HTMLElement | null;
    const card = (event.currentTarget as HTMLElement).closest('[data-cell-id]');
    if (related && card && card.contains(related)) return;
    commitCell(identity);
  };

  const orderedGrid = [...grid].sort((a, b) => {
    const aEmpty = a.manual === true && normalizeMaterialCode(a.code) === '';
    const bEmpty = b.manual === true && normalizeMaterialCode(b.code) === '';
    if (aEmpty !== bEmpty) return aEmpty ? -1 : 1;
    const codeOrder = compareMaterialCodes(a.code, b.code);
    if (codeOrder !== 0) return codeOrder;
    return a.row - b.row || a.col - b.col;
  });

  // 按确认状态筛选（只影响显示，不改数据）
  const isConfirmed = (cell: GridCell) => cell.confirmed ?? cell.result?.status === 'accepted';
  const filteredGrid = orderedGrid.filter((cell) => {
    if (filter === 'all') return true;
    return filter === 'confirmed' ? isConfirmed(cell) : !isConfirmed(cell);
  });

  return (
    <section
      role="region"
      aria-label="网格结果"
      className="p-3 sm:p-4"
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-xl)',
      }}
    >
      <header className="flex flex-wrap justify-between gap-2 mb-3">
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700 }}>
          网格结果 <small style={{ color: 'var(--color-text-muted)' }}>{filteredGrid.length} / {grid.length} 格</small>
        </h2>
        <span className="flex gap-2">
          <Button variant="secondary" onClick={onAddManual} disabled={loading || filter !== 'all'} title={filter !== 'all' ? '筛选状态下请先切回“全部”再添加' : undefined}>添加物料</Button>
          <Button variant="ghost" onClick={onClear} disabled={loading || !grid.length}>清空</Button>
        </span>
      </header>

      <div
        role="group"
        aria-label="按确认状态筛选"
        className="flex items-center gap-1 p-0.5 mb-3 w-fit"
        style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' }}
      >
        {([['all', '全部'], ['confirmed', '已确认'], ['unconfirmed', '未确认']] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className="px-3 py-1.5 text-xs rounded-lg transition-colors"
            style={{
              color: filter === value ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              background: filter === value ? 'var(--color-surface)' : 'transparent',
              fontWeight: filter === value ? 600 : 500,
              boxShadow: filter === value ? 'var(--shadow-sm)' : 'none',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {filteredGrid.length ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredGrid.map((cell) => {
            const index = grid.indexOf(cell);
            const failed = isGridFailure(cell.result);
            const identity = cell.sourceId ?? `${cell.row}-${cell.col}`;
            const codeValue = drafts[identity] ?? cell.code;
            const normalizedCode = normalizeMaterialCode(codeValue);
            const codeDuplicate = normalizedCode.length > 0
              && grid.some((other, otherIndex) => otherIndex !== index && normalizeMaterialCode(other.code) === normalizedCode);
            return (
              <article
                key={identity}
                data-cell-id={identity}
                data-testid={`materials-grid-cell-${cell.row}-${cell.col}`}
                style={{
                  position: 'relative',
                  overflow: 'hidden',
                  padding: 12,
                  border: `2px solid ${failed ? 'var(--color-error)' : cell.result?.status === 'accepted' ? 'var(--color-success)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--color-bg-primary)',
                }}
              >
                {failed && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'rgba(205, 54, 48, 0.09)',
                      pointerEvents: 'none',
                      zIndex: 0,
                    }}
                  />
                )}
                <div style={{ position: 'relative', zIndex: 1 }}>
                  <div className="flex justify-between items-center gap-2 mb-2">
                    <b style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {cell.manual ? '手工添加' : '识别结果'}
                    </b>
                    <span
                      style={{
                        color: failed ? 'var(--color-error)' : cell.result?.status === 'accepted' ? 'var(--color-success)' : 'var(--color-warning)',
                        fontSize: 12,
                      }}
                    >
                      {cell.loading ? '识别中…' : failed ? '识别失败' : cell.result?.status === 'accepted' ? '已确认' : cell.manual ? '待填写' : '待确认'}
                    </span>
                  </div>

                  {cell.loading ? (
                    <div className="py-6 text-center" style={{ color: 'var(--color-text-muted)' }}>识别中…</div>
                  ) : (
                    <>
                      {failed && (
                        <div className="flex items-center justify-between gap-2 mb-2" role="alert">
                          <span style={{ color: 'var(--color-error)', fontSize: 12 }}>{cell.result?.diagnostics ?? '未识别到有效结果'}</span>
                          <Button variant="danger" onClick={() => onRetry(index)} disabled={loading}>重试</Button>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <label htmlFor={`grid-code-${identity}`}>
                          编码
                          <input
                            id={`grid-code-${identity}`}
                            name={`grid-code-${identity}`}
                            style={codeDuplicate ? { ...field, border: '1px solid var(--color-error)' } : field}
                            value={codeValue}
                            onChange={(event) => setDrafts((d) => ({ ...d, [identity]: event.target.value.toUpperCase() }))}
                            onBlur={(event) => handleFieldBlur(event, identity)}
                          />
                          {codeDuplicate && (
                            <div style={{ color: 'var(--color-error)', fontSize: 12, marginTop: 2 }}>与已有编码重复</div>
                          )}
                        </label>
                        <label htmlFor={`grid-count-${identity}`}>
                          数量
                          <input id={`grid-count-${identity}`} name={`grid-count-${identity}`} style={field} value={cell.count} onChange={(event) => onChange(index, 'count', event.target.value)} onBlur={(event) => handleFieldBlur(event, identity)} inputMode="numeric" />
                        </label>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <label className="flex items-center gap-1 text-xs" style={{ color: cell.confirmed ? 'var(--color-success)' : 'var(--color-warning)' }}>
                          <input type="checkbox" checked={cell.confirmed ?? cell.result?.status === 'accepted'} onChange={(event) => onToggleConfirmed(index, event.target.checked)} />
                          已确认
                        </label>
                        <Button variant="secondary" onClick={() => onDelete(index)}>删除</Button>
                        <Button variant="ghost" onClick={() => onJump(cell)} disabled={!cell.bbox.w || !cell.bbox.h} title={cell.bbox.w && cell.bbox.h ? '定位原格' : '手工添加项没有原格坐标'}>
                          定位
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
          {filter === 'confirmed' ? '暂无已确认的物料' : filter === 'unconfirmed' ? '暂无未确认的物料' : '暂无物料。点击“添加物料”可手工新增。'}
        </div>
      )}
    </section>
  );
});