import { useParams } from 'react-router-dom';
import { useState, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useBlueprint, useUpdateCells } from '../hooks/useBlueprints';
import { useColorLibraries, useColorLibrary } from '../hooks/useColorLibrary';
import BeadBoard from '../components/BeadBoard';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import CellEditor from '../components/CellEditor';
import ColorFilter from '../components/ColorFilter';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { CellResponse } from '../types';

export default function BlueprintDetailPage() {
  const { id } = useParams<{ id: string }>();
  const blueprintId = id ? parseInt(id) : null;
  const { data: blueprint, isLoading, error } = useBlueprint(blueprintId);

  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [highlightCode, setHighlightCode] = useState<string | null>(null);
  const [editingCell, setEditingCell] = useState<CellResponse | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [userScaled, setUserScaled] = useState(false);
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const autoFitApplied = useRef(false);

  const colorCount = useMemo(() => {
    if (!blueprint?.cells) return 0;
    const unique = new Set<string>();
    for (const c of blueprint.cells) {
      const key = c.bead_code || c.pixel_color || 'default';
      if (key !== 'default') unique.add(key);
    }
    return unique.size;
  }, [blueprint?.cells]);

  const { data: libraries } = useColorLibraries();
  const updateCells = useUpdateCells();

  const defaultLibId = libraries?.[0]?.id ?? null;
  const { data: fullLibrary } = useColorLibrary(defaultLibId);

  useEffect(() => {
    autoFitApplied.current = false;
    setUserScaled(false);
    setScale(1);
  }, [blueprint?.id]);

  const fitRef = useRef<number | null>(null);

  useEffect(() => {
    if (!boardContainerRef.current || !blueprint) return;
    const container = boardContainerRef.current;
    if (container.clientHeight === 0) {
      const t = setTimeout(() => {
        autoFitApplied.current = false;
        setUserScaled(v => !v);
      }, 100);
      return () => clearTimeout(t);
    }
    if (autoFitApplied.current) return;
    const fit = Math.max(0.05, Math.min(
      container.clientWidth / (blueprint.grid_cols * 40),
      container.clientHeight / (blueprint.grid_rows * 40),
      1
    ));
    autoFitApplied.current = true;
    fitRef.current = fit;
    if (!userScaled) setScale(fit);
  }, [blueprint?.grid_rows, blueprint?.grid_cols, userScaled]);

  const colorMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (fullLibrary?.entries) {
      for (const e of fullLibrary.entries) {
        map[e.code] = e.color_hex;
      }
    }
    return map;
  }, [fullLibrary]);

  const colorEntries = libraries?.flatMap(lib =>
    (lib.entries ?? []).map(e => ({ code: e.code, color_hex: e.color_hex, color_name: e.color_name }))
  ) ?? [];

  const handleCellSave = (cellId: number, newCode: string) => {
    updateCells.mutate({
      id: blueprintId!,
      cells: { cells: [{ id: cellId, bead_code: newCode }] },
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <motion.div
          className="text-center"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <Spinner size="lg" />
          <p
            className="mt-4"
            style={{
              color: 'var(--color-text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            加载图纸中...
          </p>
        </motion.div>
      </div>
    );
  }

  if (error || !blueprint) {
    return (
      <motion.div
        className="max-w-xl mx-auto py-20 text-center"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <div className="text-4xl mb-4">🔍</div>
        <h2
          className="text-xl font-semibold mb-2"
          style={{ color: 'var(--color-text)', fontFamily: 'var(--font-display)' }}
        >
          图纸未找到
        </h2>
        <p style={{ color: 'var(--color-text-muted)' }}>该图纸不存在或已被删除</p>
      </motion.div>
    );
  }

  const zoomIn = () => { setUserScaled(true); setScale(s => Math.min(s * 1.25, 5)); };
  const zoomOut = () => { setUserScaled(true); setScale(s => Math.max(s * 0.8, 0.05)); };
  const rotateRight = () => setRotation(r => (r + 90) % 360);
  const rotateLeft = () => setRotation(r => (r - 90 + 360) % 360);
  const handleScaleChange = (newScale: number) => { setUserScaled(true); setScale(newScale); };
  const handlePanChange = (offset: { x: number; y: number }) => setPanOffset(offset);
  const resetView = () => {
    autoFitApplied.current = false;
    setUserScaled(false);
    if (boardContainerRef.current && blueprint) {
      const fit = Math.max(0.05, Math.min(
        boardContainerRef.current.clientWidth / (blueprint.grid_cols * 40),
        boardContainerRef.current.clientHeight / (blueprint.grid_rows * 40),
        1
      ));
      setScale(fit);
    } else {
      setScale(1);
    }
    setRotation(0);
    setPanOffset({ x: 0, y: 0 });
  };

  return (
    <div className="h-[calc(100dvh-56px)] flex flex-col">
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="flex items-center gap-2 lg:gap-3 px-3 lg:px-4 py-2 shrink-0"
        style={{
          background: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <motion.button
          variants={staggerItem}
          onClick={() => setFilterExpanded(!filterExpanded)}
          className="lg:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium min-w-[40px] min-h-[40px]"
          style={{
            background: 'var(--color-accent-light)',
            color: 'var(--color-accent)',
            outline: '2px solid var(--color-accent)',
            outlineOffset: '-1px',
          }}
        >
          <span>🎨</span>
          <span>{colorCount} 色</span>
          <span>{filterExpanded ? '▴' : '▾'}</span>
        </motion.button>

        <motion.div variants={staggerItem} className="hidden lg:flex items-center gap-1">
          <Button variant="ghost" onClick={zoomOut} disabled={scale <= 0.05} title="缩小" className="min-w-[40px] min-h-[40px]">−</Button>
          <span className="text-sm w-14 text-center" style={{ color: 'var(--color-text-secondary)' }}>{Math.round(scale * 100)}%</span>
          <Button variant="ghost" onClick={zoomIn} disabled={scale >= 5} title="放大" className="min-w-[40px] min-h-[40px]">+</Button>
        </motion.div>

        <motion.div variants={staggerItem} className="hidden lg:flex items-center gap-1">
          <Button variant="ghost" onClick={rotateLeft} title="左旋90°" className="min-w-[40px] min-h-[40px]">↺</Button>
          <Button variant="ghost" onClick={rotateRight} title="右旋90°" className="min-w-[40px] min-h-[40px]">↻</Button>
        </motion.div>

        <div className="flex-1" />

        <motion.span
          variants={staggerItem}
          className="text-sm"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {blueprint.grid_rows}×{blueprint.grid_cols}
        </motion.span>

        <motion.div variants={staggerItem} className="hidden lg:block">
          <Button variant="ghost" onClick={resetView} className="text-xs">重置</Button>
        </motion.div>

        <motion.button
          variants={staggerItem}
          onClick={() => setSidebarOpen(true)}
          className="lg:hidden p-2 rounded-lg min-w-[40px] min-h-[40px] flex items-center justify-center"
          style={{
            background: 'var(--color-bg-secondary)',
            color: 'var(--color-text-secondary)',
          }}
          aria-label="查看图纸信息"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </motion.button>
      </motion.div>

      {blueprint.cells && (
        <ColorFilter
          cells={blueprint.cells.map(c => ({ bead_code: c.bead_code, pixel_color: c.pixel_color }))}
          colorMap={colorMap}
          activeCode={highlightCode}
          onSelect={setHighlightCode}
          collapsed={!filterExpanded}
          onToggleCollapse={() => setFilterExpanded(!filterExpanded)}
        />
      )}

      <div className="flex-1 flex overflow-hidden" style={{ alignItems: 'stretch' }}>
        <div
          className="flex-1 relative overflow-y-auto pb-12 lg:pb-0"
          ref={boardContainerRef}
          style={{
            minHeight: 0,
            borderRight: '1px solid var(--color-border)',
          }}
        >
          <BeadBoard
            cells={blueprint.cells?.map(c => ({
              id: c.id,
              blueprint_id: c.blueprint_id,
              row_idx: c.row_idx,
              col_idx: c.col_idx,
              bead_code: c.bead_code,
              pixel_color: c.pixel_color ?? null,
            })) || []}
            gridRows={blueprint.grid_rows}
            gridCols={blueprint.grid_cols}
            highlightCode={highlightCode}
            scale={scale}
            rotation={rotation}
            colorMap={colorMap}
            panOffset={panOffset}
            onPanChange={handlePanChange}
            onCellClick={(cell) => setEditingCell(cell)}
            onScaleChange={handleScaleChange}
          />
        </div>

        <div
          className="hidden lg:block w-64 p-4 shrink-0 overflow-y-auto"
          style={{
            background: 'var(--color-surface)',
            borderLeft: '1px solid var(--color-border)',
          }}
        >
          <h3
            className="font-medium mb-3"
            style={{
              color: 'var(--color-text)',
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-lg)',
            }}
          >
            图纸信息
          </h3>
          <div className="space-y-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>名称:</span>{' '}
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                {blueprint.name || '未命名'}
              </span>
            </div>
            <div><span style={{ color: 'var(--color-text-muted)' }}>尺寸:</span> {blueprint.grid_rows} × {blueprint.grid_cols}</div>
            <div><span style={{ color: 'var(--color-text-muted)' }}>豆子:</span> {blueprint.cells?.length || 0} 个</div>
            <div><span style={{ color: 'var(--color-text-muted)' }}>状态:</span> {blueprint.status === 'ready' ? '✅ 就绪' : blueprint.status === 'processing' ? '⏳ 解析中' : '❌ 错误'}</div>
          </div>
        </div>
      </div>

      <div
        className="lg:hidden fixed inset-x-0 bottom-0 z-30 px-4 py-3 flex items-center justify-between"
        style={{
          height: '48px',
          background: 'var(--color-bg-elevated)',
          borderTop: '1px solid var(--color-border)',
        }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={zoomOut}
            disabled={scale <= 0.05}
            className="w-11 h-11 rounded-lg text-xl font-bold flex items-center justify-center min-w-[44px] min-h-[44px]"
            style={{
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text)',
            }}
          >−</button>
          <span className="text-sm w-14 text-center" style={{ color: 'var(--color-text-secondary)' }}>{Math.round(scale * 100)}%</span>
          <button
            onClick={zoomIn}
            disabled={scale >= 5}
            className="w-11 h-11 rounded-lg text-xl font-bold flex items-center justify-center min-w-[44px] min-h-[44px]"
            style={{
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text)',
            }}
          >+</button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={rotateLeft}
            className="w-11 h-11 rounded-lg text-xl flex items-center justify-center min-w-[44px] min-h-[44px]"
            style={{
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text)',
            }}
          >↺</button>
          <button
            onClick={rotateRight}
            className="w-11 h-11 rounded-lg text-xl flex items-center justify-center min-w-[44px] min-h-[44px]"
            style={{
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text)',
            }}
          >↻</button>
        </div>
        <button
          onClick={resetView}
          className="px-3 h-11 rounded-lg text-sm font-medium min-w-[44px] min-h-[44px]"
          style={{
            background: 'var(--color-bg-secondary)',
            color: 'var(--color-text)',
          }}
        >重置</button>
        <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>{blueprint.grid_rows}×{blueprint.grid_cols}</span>
      </div>

      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div
              className="lg:hidden fixed inset-0 z-40"
              style={{ background: 'rgba(61, 43, 31, 0.5)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setSidebarOpen(false)}
            />
            <motion.div
              className="lg:hidden fixed inset-x-0 bottom-12 z-50 rounded-t-2xl overflow-hidden"
              style={{
                height: '40dvh',
                background: 'var(--color-surface)',
                borderTop: '1px solid var(--color-border)',
                boxShadow: 'var(--shadow-xl)',
              }}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            >
              <div
                className="flex items-center justify-between p-4"
                style={{ borderBottom: '1px solid var(--color-border)' }}
              >
                <h3
                  className="font-medium"
                  style={{
                    color: 'var(--color-text)',
                    fontFamily: 'var(--font-display)',
                  }}
                >
                  图纸信息
                </h3>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="p-2 rounded-lg min-w-[40px] min-h-[40px] flex items-center justify-center"
                  style={{
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text)',
                  }}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-4 space-y-3 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                <div>
                  <span style={{ color: 'var(--color-text-muted)' }}>名称:</span>{' '}
                  <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                    {blueprint.name || '未命名'}
                  </span>
                </div>
                <div><span style={{ color: 'var(--color-text-muted)' }}>尺寸:</span> {blueprint.grid_rows} × {blueprint.grid_cols}</div>
                <div><span style={{ color: 'var(--color-text-muted)' }}>豆子:</span> {blueprint.cells?.length || 0} 个</div>
                <div><span style={{ color: 'var(--color-text-muted)' }}>状态:</span> {blueprint.status === 'ready' ? '✅ 就绪' : blueprint.status === 'processing' ? '⏳ 解析中' : '❌ 错误'}</div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <CellEditor
        cell={editingCell}
        colorEntries={colorEntries}
        onSave={handleCellSave}
        onClose={() => setEditingCell(null)}
      />
    </div>
  );
}
