import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BlueprintCellDto, ColorDto } from '../types/api';
import { computeBreakdown, naturalCompare } from '../lib/correctionModel';

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

  // 下拉候选：按输入过滤（编码/名称子串）+ **编码自然排序**（A1 < A2 < A10，数字感知）
  const candidates = useMemo(() => {
    const q = upper.trim();
    const filtered = q
      ? swatches.filter(
          (c) => c.code.includes(q) || c.name.toLowerCase().includes(q.toLowerCase()),
        )
      : swatches;
    return [...filtered].sort((a, b) => naturalCompare(a.code, b.code));
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

  // 输入框失焦**不收起**下拉：只在选中编码（pick）后收回——点击弹窗其他区域不再让弹窗"缩一下"

  // 移动端点击单元格打开弹窗时不自动聚焦（autoFocus 会呼出输入法）；桌面保留直接输入
  const autoFocusInput = useMemo(
    () => typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: coarse)').matches,
    [],
  );

  // 弹窗打开期间锁页面滚动：输入法弹出（visual viewport 变小）时不产生页面滚动条。
  // 移动端 overflow:hidden 在 html/body 上并不可靠（iOS Safari/部分 Chrome 仍可滚）——
  // 用 position:fixed 经典方案：fixed 元素不参与页面滚动，恢复时还原滚动位置。
  useEffect(() => {
    const body = document.body;
    const prevPosition = body.style.position;
    const prevWidth = body.style.width;
    const prevTop = body.style.top;
    const scrollY = window.scrollY;
    body.style.position = 'fixed';
    body.style.width = '100%';
    body.style.top = `-${scrollY}px`;
    return () => {
      body.style.position = prevPosition;
      body.style.width = prevWidth;
      body.style.top = prevTop;
      if (prevPosition !== 'fixed') window.scrollTo(0, scrollY);
    };
  }, []);

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
    // 注意：不能 focus 回输入框——focus 会触发 onFocus → setOpen(true)，下拉重新打开
  };

  return createPortal(
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-4"
      style={{ background: 'rgba(61, 43, 31, 0.45)' }}
      onMouseDown={onClose /* mousedown 先于输入框 blur：直接卸载弹窗，无"收下拉再关"的闪烁 */}
    >
      <div
        className="w-[min(560px,94vw)] max-h-[92vh] overflow-y-auto rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xl)]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
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

        {/* 编码选择：输入框 + 主操作"设为"同行（输入完直接点，不跨行找按钮）
            下拉为文档流（static）：展开时弹窗高度自然包含它，不再溢出弹框 */}
        <div className="mb-3">
          <div className="flex items-start gap-2">
            <div className="relative flex-1">
              <input
                ref={inputRef}
                value={code}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleInputKeyDown}
                onFocus={() => setOpen(true)}
                placeholder={singleInfo ? `当前 ${singleInfo.current} · 输入或选择编码` : '输入或选择编码（如 A10）'}
                autoFocus={autoFocusInput}
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
          {open && (
            <div
              data-testid="code-dropdown"
              className="mt-2 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)]"
              style={{ maxHeight: 320, padding: 4 }}
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
    </div>,
    document.body,
  );
}
