import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlueprintCellDto, ColorDto } from '../types/api';
import { computeBreakdown } from '../lib/correctionModel';

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
 * 编码修正弹窗（单格/多格共用）：
 * - 选择 = 受控下拉（combobox）：输入即过滤（编码/名称），↑↓ 键盘导航、
 *   Enter 提交选中项、Esc 先关下拉再关弹窗
 * - 单格模式显示坐标/当前码，多格显示识别汇总
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
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const breakdown = useMemo(() => computeBreakdown(editor.keys, cellsByPos), [editor.keys, cellsByPos]);

  const upper = code.trim().toUpperCase();
  const valid = validCodes.includes(upper) || upper === 'BLANK';

  // 下拉候选：按输入过滤（编码前缀/子串 + 名称子串，与输入大小写无关）
  const candidates = useMemo(() => {
    const q = upper.trim();
    if (!q) return swatches;
    return swatches.filter(
      (c) => c.code.includes(q) || c.name.toLowerCase().includes(q.toLowerCase()),
    );
  }, [swatches, upper]);

  // 单格模式：坐标 + 当前有效码（画布同源：correctedCode ?? code）
  const singleKey = editor.keys.length === 1 ? editor.keys[0] : null;
  const singleCell = singleKey ? cellsByPos.get(singleKey) : undefined;
  const singleInfo = singleCell
    ? {
        row: singleCell.row + 1,
        col: singleCell.col + 1,
        current: singleCell.status === 'BLANK' || (singleCell.correctedCode ?? singleCell.code) === 'BLANK'
          ? '空白'
          : (singleCell.correctedCode ?? singleCell.code),
      }
    : null;

  // Esc：下拉开着先关下拉，否则关弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (open) setOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const commit = async (value: string) => {
    const target = value.trim().toUpperCase();
    if (!(validCodes.includes(target) || target === 'BLANK') || busy) return;
    setBusy(true);
    try {
      await onConfirmSet(target);
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

  const handleInputChange = (value: string) => {
    setCode(value.toUpperCase());
    setOpen(true);
    setActiveIndex(-1);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIndex((prev) => (prev + 1) % Math.max(1, candidates.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? candidates.length - 1 : prev - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // 下拉有选中项 → 提交选中项；否则提交输入框内容
      const target = activeIndex >= 0 ? candidates[activeIndex]?.code : upper;
      if (target) void commit(target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const pickCandidate = (c: ColorDto) => {
    setCode(c.code);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-4"
      style={{ background: 'rgba(61, 43, 31, 0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-[min(480px,92vw)] max-h-[85vh] overflow-y-auto rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xl)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题：单格"换一颗豆" + 坐标/当前码；多格保持"修正 N 格" + 识别汇总 */}
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)' }}>
              {singleInfo ? '换一颗豆' : `修正 ${editor.keys.length} 格`}
            </h2>
            {singleInfo ? (
              <p className="mt-1.5" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                第 {singleInfo.row} 行 · 第 {singleInfo.col} 列 · 当前{' '}
                <span style={{ color: 'var(--color-text-secondary)' }}>{singleInfo.current}</span>
              </p>
            ) : breakdown.length > 0 ? (
              <p className="mt-1.5" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                当前识别：
                <span style={{ color: 'var(--color-text-secondary)' }}>{breakdown.map((b) => `${b.code}×${b.count}`).join('、')}</span>
              </p>
            ) : null}
          </div>
          <button type="button" onClick={onClose} style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xl)', lineHeight: 1, padding: 4 }} aria-label="关闭">×</button>
        </div>

        {/* 编码选择：输入框 + 主操作"设为"同行（输入完直接点，不跨行找按钮） */}
        <div className="mb-3 flex items-start gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              value={code}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleInputKeyDown}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              placeholder="输入或选择编码（如 A10）"
              autoFocus
              style={{
                ...controlStyle(),
                width: '100%',
                height: 42,
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                fontSize: 'var(--text-base)',
                borderColor: code && !valid ? 'var(--color-error)' : 'var(--color-border)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
              aria-label="修正编码"
            />
            {code && !valid && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--color-error)' }}>
                不在颜色库
              </span>
            )}
            {open && (
              <div
                data-testid="code-dropdown"
                className="absolute left-0 right-0 top-[calc(100%+8px)] z-10 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)]"
                style={{ maxHeight: 256, padding: 4 }}
                onMouseDown={(e) => e.preventDefault() /* 阻止 blur 先于 click */}
              >
                {candidates.length === 0 ? (
                  <div className="px-3 py-2.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    没有匹配的编码
                  </div>
                ) : (
                  candidates.map((c, i) => (
                    <button
                      key={c.code}
                      type="button"
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => pickCandidate(c)}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 10,
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 'var(--radius-md)',
                        border: 'none',
                        background: i === activeIndex ? 'var(--color-surface-hover)' : 'transparent',
                        color: 'var(--color-text)',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontSize: 'var(--text-sm)',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{c.code}</span>
                      {c.name !== c.code && (
                        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>{c.name}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void commit(upper)}
            disabled={!valid || busy}
            style={{
              ...actionBtn('var(--color-accent)', !valid || busy),
              height: 42,
              padding: '0 20px',
              whiteSpace: 'nowrap',
            }}
          >
            {valid && upper ? `设为 ${upper}` : '设为…'}
          </button>
        </div>

        {/* 次级操作：恢复原码（弱化，muted 文字按钮）+ 空白格（描边） */}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRevert()}
            disabled={busy}
            style={{
              border: 'none',
              background: 'transparent',
              padding: '6px 2px',
              color: 'var(--color-text-muted)',
              fontSize: 'var(--text-sm)',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.5 : 1,
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            恢复原码
          </button>
          <span style={{ width: 1, height: 14, background: 'var(--color-border)' }} />
          <button
            type="button"
            onClick={() => { setCode('BLANK'); setOpen(false); inputRef.current?.focus(); }}
            style={{ padding: '7px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border-strong)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', fontWeight: 500, cursor: 'pointer' }}
          >设为空白</button>
        </div>
      </div>
    </div>
  );
}
