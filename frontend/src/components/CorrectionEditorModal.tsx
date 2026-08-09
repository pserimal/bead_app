import { useMemo, useState } from 'react';
import type { BlueprintCellDto, ColorDto } from '../types/api';
import { computeBreakdown } from '../lib/correctionModel';

function normalizeHex(hex: string | null | undefined): string | null {
  const value = (hex ?? '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null;
}

function controlStyle(): React.CSSProperties {
  return {
    height: 34,
    padding: '0 10px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--text-sm)',
  };
}

function actionBtn(color: string, disabled = false): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: color,
    color: '#fff',
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

/**
 * 批量修正弹窗：编码输入（校验 validCodes/BLANK）+ 色相排序色板 + 恢复原码。
 * 与全局 Modal 同语言（surface + radius-xl + shadow-xl + 暖褐遮罩）。
 */
export default function CorrectionEditorModal({
  editor,
  cellsByPos,
  swatches,
  validCodes,
  onClose,
  onConfirmSet,
  onConfirmRevert,
}: {
  editor: { keys: string[] };
  cellsByPos: Map<string, BlueprintCellDto>;
  swatches: ColorDto[];
  validCodes: string[];
  onClose: () => void;
  onConfirmSet: (code: string) => void;
  onConfirmRevert: () => void;
}) {
  const [code, setCode] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const breakdown = useMemo(() => computeBreakdown(editor.keys, cellsByPos), [editor.keys, cellsByPos]);

  const upper = code.trim().toUpperCase();
  const valid = validCodes.includes(upper) || upper === 'BLANK';
  const shownSwatches = filter
    ? swatches.filter((c) => c.code.includes(filter.toUpperCase()) || c.name.toLowerCase().includes(filter.toLowerCase()))
    : swatches;

  const handleSet = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onConfirmSet(upper);
    } finally {
      setBusy(false);
    }
  };

  const handleRevert = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirmRevert();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-4"
      style={{ background: 'rgba(61, 43, 31, 0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] max-h-[85vh] overflow-y-auto rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xl)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)' }}>
            修正 {editor.keys.length} 格
          </h2>
          <button type="button" onClick={onClose} style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-lg)', lineHeight: 1 }} aria-label="关闭">×</button>
        </div>

        {breakdown.length > 0 && (
          <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
            当前识别：
            <span style={{ fontFamily: 'var(--font-mono)' }}>{breakdown.map((b) => `${b.code}×${b.count}`).join('、')}</span>
          </p>
        )}

        <div className="flex gap-2 mb-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="输入编码（如 A10），或从下方色板选择"
            autoFocus
            list="correction-codes"
            style={{
              ...controlStyle(),
              flex: 1,
              height: 38,
              borderColor: code && !valid ? 'var(--color-error)' : undefined,
            }}
            aria-label="修正编码"
          />
          <datalist id="correction-codes">
            {validCodes.map((c) => <option key={c} value={c} />)}
          </datalist>
          {code && !valid && (
            <span className="text-xs self-center" style={{ color: 'var(--color-error)', whiteSpace: 'nowrap' }}>
              编码不在颜色库
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 mb-3">
          <button type="button" onClick={handleSet} disabled={!valid || busy} style={actionBtn('var(--color-accent)', !valid || busy)}>
            设为 {valid ? upper : '…'}（{editor.keys.length} 格）
          </button>
          <button type="button" onClick={handleRevert} disabled={busy} style={actionBtn('var(--color-success)', busy)}>
            恢复原码
          </button>
          <button
            type="button"
            onClick={() => setCode('BLANK')}
            style={{ padding: '8px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border-strong)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', fontWeight: 500, cursor: 'pointer' }}
          >空白格 BLANK</button>
        </div>

        <div className="flex gap-2 items-center mb-2">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>色板</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按编码或名称筛选"
            style={{ ...controlStyle(), height: 30, flex: 1 }}
            aria-label="筛选色板"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {shownSwatches.map((c) => (
            <button
              key={c.code}
              type="button"
              title={`${c.code} · ${c.name}`}
              onClick={() => setCode(c.code)}
              style={{
                width: 34,
                height: 34,
                borderRadius: 7,
                background: normalizeHex(c.hex) ?? '#eee',
                border: upper === c.code ? '2px solid var(--color-accent)' : '1px solid rgba(0,0,0,0.12)',
                cursor: 'pointer',
              }}
              aria-label={c.code}
            />
          ))}
          {shownSwatches.length === 0 && (
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>没有匹配的颜色</span>
          )}
        </div>
      </div>
    </div>
  );
}
