import { useEffect, useMemo, useRef, useState } from 'react';
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
 * 拼豆色板项：一颗拼豆——圆柱造型（顶部高光 + 底部内阴影）+ 中心孔洞（拼豆的招牌特征）。
 * 选中态 = accent 描边 + 微微上浮（"拿起这颗豆"）。
 */
function Bead({
  hex,
  selected,
  matched,
  onClick,
  label,
}: {
  hex: string;
  selected: boolean;
  matched: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      aria-label={label.split(' · ')[0]}
      style={{
        width: 38,
        height: 38,
        borderRadius: '50%',
        background: `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.55), rgba(255,255,255,0) 46%), ${hex}`,
        border: selected
          ? '2px solid var(--color-accent)'
          : matched
            ? '2px solid var(--color-accent-light)'
            : '1px solid rgba(61,43,31,0.14)',
        boxShadow:
          'inset 0 -3px 5px rgba(61,43,31,0.14), inset 0 2px 3px rgba(255,255,255,0.5), 0 1px 2px rgba(61,43,31,0.1)',
        transform: selected ? 'translateY(-2px) scale(1.04)' : undefined,
        cursor: 'pointer',
        position: 'relative',
        padding: 0,
        transition: 'transform 120ms ease, border-color 120ms ease',
      }}
    >
      {/* 中心孔：拼豆中空 */}
      <span
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 9,
          height: 9,
          transform: 'translate(-50%, -50%)',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(61,43,31,0.4), rgba(61,43,31,0.12))',
          pointerEvents: 'none',
        }}
      />
    </button>
  );
}

/**
 * 编码修正弹窗（单格/多格共用）：
 * - 交互：Enter 提交、Esc 关闭、点击豆子填入编码、输入与豆盘联动高亮
 * - 视效：色板 = 一盘拼豆（圆柱高光 + 中心孔），选中"拿起"；标题随模式切换
 *   （单格显示坐标/当前码，多格显示识别汇总）
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
  const inputRef = useRef<HTMLInputElement>(null);
  const breakdown = useMemo(() => computeBreakdown(editor.keys, cellsByPos), [editor.keys, cellsByPos]);

  const upper = code.trim().toUpperCase();
  const valid = validCodes.includes(upper) || upper === 'BLANK';
  const shownSwatches = filter
    ? swatches.filter((c) => c.code.includes(filter.toUpperCase()) || c.name.toLowerCase().includes(filter.toLowerCase()))
    : swatches;

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

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Enter 提交（输入框内）
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && valid && !busy) {
      e.preventDefault();
      void handleSet();
    }
  };

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

  // 点击豆子：填入编码并聚焦输入框（等待下一步确认；Enter 或"设为"生效）
  const pickBead = (c: ColorDto) => {
    setCode(c.code);
    inputRef.current?.focus();
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-4"
      style={{ background: 'rgba(61, 43, 31, 0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] max-h-[85vh] overflow-y-auto rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xl)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题：单格"换一颗豆" + 坐标/当前码；多格保持"修正 N 格" + 识别汇总 */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)' }}>
              {singleInfo ? '换一颗豆' : `修正 ${editor.keys.length} 格`}
            </h2>
            {singleInfo ? (
              <p className="mt-1" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                第 {singleInfo.row} 行 · 第 {singleInfo.col} 列 · 当前{' '}
                <span style={{ color: 'var(--color-text-secondary)' }}>{singleInfo.current}</span>
              </p>
            ) : breakdown.length > 0 ? (
              <p className="mt-1" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                当前识别：
                <span style={{ color: 'var(--color-text-secondary)' }}>{breakdown.map((b) => `${b.code}×${b.count}`).join('、')}</span>
              </p>
            ) : null}
          </div>
          <button type="button" onClick={onClose} style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-lg)', lineHeight: 1 }} aria-label="关闭">×</button>
        </div>

        <div className="flex gap-2 mb-3">
          <input
            ref={inputRef}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={handleInputKeyDown}
            placeholder="输入编码（如 A10），或从豆盘选一颗"
            autoFocus
            list="correction-codes"
            style={{
              ...controlStyle(),
              flex: 1,
              height: 40,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              fontSize: 'var(--text-base)',
              borderColor: code && !valid ? 'var(--color-error)' : 'var(--color-border)',
              outline: 'none',
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

        <div className="flex flex-wrap gap-2 mb-4">
          <button type="button" onClick={() => void handleSet()} disabled={!valid || busy} style={actionBtn('var(--color-accent)', !valid || busy)}>
            {valid && upper ? `设为 ${upper}` : '设为…'}
          </button>
          <button type="button" onClick={() => void handleRevert()} disabled={busy} style={actionBtn('var(--color-success)', busy)}>
            恢复原码
          </button>
          <button
            type="button"
            onClick={() => { setCode('BLANK'); inputRef.current?.focus(); }}
            style={{ padding: '8px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border-strong)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', fontWeight: 500, cursor: 'pointer' }}
          >空白格 BLANK</button>
        </div>

        <div className="flex gap-2 items-center mb-2">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>豆盘</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按编码或名称筛选"
            style={{ ...controlStyle(), height: 30, flex: 1 }}
            aria-label="筛选色板"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {shownSwatches.map((c) => (
            <Bead
              key={c.code}
              hex={normalizeHex(c.hex) ?? '#eee'}
              selected={upper === c.code}
              matched={!upper ? false : c.code.includes(upper) || c.code === upper}
              onClick={() => pickBead(c)}
              label={`${c.code} · ${c.name}`}
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
