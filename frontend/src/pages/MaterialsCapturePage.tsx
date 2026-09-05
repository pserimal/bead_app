import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import Button from '../components/Button';
import MaterialsCanvas from '../components/MaterialsCanvas';
import { GridPanel } from '../components/MaterialsPanels';
import { useToast } from '../components/ToastContext';
import { exportLegendSamples, saveBlueprintLegend } from '../api/materials';
import {
  savePendingWizard,
  type PendingWizardState,
} from '../lib/pendingUpload';
import {
  sortMaterials,
  toEntries,
  useMaterialsCapture,
  type Box,
  type CaptureInput,
  type GridCell,
  type Material,
  type View,
} from '../hooks/useMaterialsCapture';
import { SerialSaveQueue } from '../lib/saveQueue';

const inputStyle: React.CSSProperties = {
  width: 52,
  height: 34,
  textAlign: 'center',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-bg-primary)',
  fontSize: 16,
};

function wizardSnapshot(input: CaptureInput, box: Box, inventory: Material[], step: PendingWizardState['step']): PendingWizardState {
  return {
    step,
    imageUrl: input.imageUrl,
    imageW: input.imageW,
    imageH: input.imageH,
    crop: input.crop ?? null,
    materialsBox: box,
    rows: input.rows,
    cols: input.cols,
    materialsRows: input.materialsRows,
    materialsCols: input.materialsCols,
    codes: input.codes,
    jobName: input.jobName,
    skipLegendPrompt: input.skipLegendPrompt,
    legendInventory: inventory,
  };
}

export default function MaterialsCapturePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const blueprintId = params.get('blueprint');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { state, dispatch, stageRef, fit, recognize, recognizeGrid, retryGridCell } = useMaterialsCapture(blueprintId);
  const [rowsText, setRowsText] = useState(() => String(state.rows));
  const [colsText, setColsText] = useState(() => String(state.cols));
  const [rowsFocused, setRowsFocused] = useState(false);
  const [colsFocused, setColsFocused] = useState(false);
  // 服务端恢复是异步的（图片加载后才 set rows/cols），晚于挂载的 useState 初值；
  // 输入框未聚焦时直接展示 state 值（恢复/重置即时可见），聚焦编辑中才用本地文本态。
  // 自动保存状态：idle（无变更）/ saving（POST 进行中）/ saved（已保存）/ error（保存失败）
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  const [highlightedBox, setHighlightedBox] = useState<Box | null>(null);
  // 重新框选模式：点「重新框选」后在画布上按下拖动重画框选区域，画完自动退出
  const [redrawing, setRedrawing] = useState(false);
  const input = state.input;
  // 跳过首次挂载（补录模式拉取已保存清单 → dispatch inventory → 不应触发一次无谓保存）
  const skipFirstSaveRef = useRef(true);

  // Keep the whole wizard resumable while this page is open. File bytes live in
  // IndexedDB; this snapshot intentionally contains only serializable metadata.
  // 防抖 400ms：避免拖框/编辑时每帧同步 JSON.stringify + sessionStorage 写入阻塞主线程。
  useEffect(() => {
    if (blueprintId || !input || !input.imageW || !input.imageH) return;
    const snapshot = wizardSnapshot(
      { ...input, materialsRows: state.rows, materialsCols: state.cols },
      state.box,
      sortMaterials(state.inventory),
      'materials',
    );
    const timer = window.setTimeout(() => savePendingWizard(snapshot), 400);
    return () => {
      window.clearTimeout(timer);
      savePendingWizard(snapshot);
    };
  }, [blueprintId, input, state.box, state.cols, state.inventory, state.rows]);

  const addManual = useCallback(() => {
    const sourceId = `manual-${Date.now()}-${state.grid.length}`;
    dispatch({
      type: 'grid',
      grid: [
        ...state.grid,
        {
          row: Number.MAX_SAFE_INTEGER,
          col: state.grid.length,
          bbox: { x: 0, y: 0, w: 0, h: 0 },
          result: null,
          code: '',
          count: '',
          loading: false,
          manual: true,
          sourceId,
        },
      ],
    });
    setAutoFocusId(sourceId);
  }, [dispatch, state.grid]);

  const updateGrid = useCallback((index: number, field: 'code' | 'count', value: string) => {
    dispatch({ type: 'error', error: null });
    dispatch({ type: 'grid', grid: state.grid.map((cell, cellIndex) => cellIndex === index ? { ...cell, [field]: value } : cell) });
  }, [dispatch, state.grid]);

  const jump = useCallback((cell: GridCell) => {
    if (!cell.bbox.w || !cell.bbox.h) return;
    setHighlightedBox(cell.bbox);
    // 高亮定位后把焦点交给图纸画布：拖拽/缩放等画布内操作期间高亮保持，
    // 焦点离开画布（点击页面其他区域）时才消失。
    stageRef.current?.focus({ preventScroll: true });
    stageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [stageRef]);

  const deleteGridCell = useCallback((index: number) => {
    dispatch({ type: 'grid', grid: state.grid.filter((_, cellIndex) => cellIndex !== index) });
  }, [dispatch, state.grid]);

  const toggleGridConfirmed = useCallback((index: number, confirmed: boolean) => {
    dispatch({ type: 'gridCell', index, cell: { ...state.grid[index], confirmed } });
  }, [dispatch, state.grid]);

  const rejectCode = useCallback((code: string) => {
    dispatch({ type: 'error', error: `编码 ${code} 已存在，请使用其他编码` });
  }, [dispatch]);

  const clearGrid = useCallback(() => {
    dispatch({ type: 'grid', grid: [] });
  }, [dispatch]);

  const onBox = useCallback((box: Box) => {
    dispatch({ type: 'box', box });
  }, [dispatch]);

  const onView = useCallback((view: View) => {
    dispatch({ type: 'view', view });
  }, [dispatch]);

  const onFocusLeave = useCallback(() => {
    setHighlightedBox(null);
  }, []);

  /** 把当前 inventory 持久化到服务端（自动保存 + 导出前可复用）。
   *  无效条目（缺编码/数量）静默跳过，不落库也不打断编辑——用户补全后自然再次触发。
   *  并发控制：SerialSaveQueue 串行化——同一时刻最多一个 POST；in-flight 期间的
   *  新修改挂起，当前请求完成后自动补发最新数据（latest-wins，避免旧请求晚到覆盖）。
   *  返回导航无需特殊处理：POST 在组件卸载后继续完成，最终落库的是最后一次修改。 */
  const saveQueueRef = useRef(new SerialSaveQueue<Material[]>());
  const persist = useCallback(async (inventory: Material[]) => {
    if (!blueprintId) return;
    // 串行发送：同一时刻一个 POST；in-flight 期间的新修改挂起，完成后自动补发
    // 最新数据（latest-wins，旧请求晚到不会覆盖）。返回导航后 POST 继续完成，
    // 最终落库的是最后一次修改。
    let current = inventory;
    while (true) {
      const payload = toEntries(current);
      if (payload.length === 0) {
        // 空清单不发送：不占用也不触碰队列（in-flight 的挂起数据由在跑请求负责补发）
        return;
      }
      if (!saveQueueRef.current.submit(current)) return; // 已有 in-flight：挂起，由补发覆盖
      setSaveState('saving');
      try {
        await saveBlueprintLegend(blueprintId, payload);
        queryClient.setQueryData(['legend', blueprintId], payload);
        await queryClient.invalidateQueries({ queryKey: ['legend', blueprintId] });
        setSaveState('saved');
      } catch (error) {
        setSaveState('error');
        toast(error instanceof Error ? error.message : '保存失败', 'error');
      }
      // 无论成败：挂起期间累积的最新修改立即补发（失败也不丢）
      const next = saveQueueRef.current.finish();
      if (next == null) return;
      current = next;
    }
  }, [blueprintId, queryClient, toast]);

  // 自动保存：任何修改（逐格编辑/增删/确认/清空/识别结果）都会更新 inventory，
  // 这里统一监听并立即 POST（无 debounce）。跳过首次挂载的初始加载。
  useEffect(() => {
    if (!blueprintId) return;
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false;
      return;
    }
    void persist(state.inventory);
  }, [blueprintId, persist, state.inventory]);

  if (!input || !input.imageUrl || !input.imageW || !input.imageH) {
    return <div className="max-w-4xl mx-auto p-6" style={{ color: 'var(--color-text-muted)' }}>正在恢复图纸…</div>;
  }

  const setSize = (which: 'rows' | 'cols', value: string) => {
    if (which === 'rows') setRowsText(value);
    else setColsText(value);
    if (!value) return;
    const number = Math.max(1, Math.min(20, Number.parseInt(value, 10) || 1));
    dispatch({ type: 'gridSize', rows: which === 'rows' ? number : state.rows, cols: which === 'cols' ? number : state.cols });
  };

  const finish = () => {
    const old = (location.state as CaptureInput | null) ?? input;
    const result = {
      restoreUpload: true,
      imageUrl: input.imageUrl,
      imageW: input.imageW,
      imageH: input.imageH,
      imageFile: input.imageFile,
      crop: old.crop ?? null,
      rows: old.rows,
      cols: old.cols,
      codes: old.codes,
      jobName: old.jobName,
      legendInventory: sortMaterials(state.inventory),
    };
    savePendingWizard(wizardSnapshot({ ...input, ...result }, state.box, sortMaterials(state.inventory), 'upload'));
    navigate('/', { state: result });
  };

  const exportSamples = () => {
    if (!blueprintId) return;
    void exportLegendSamples(blueprintId)
      .then(() => toast('已开始下载已确认样本包', 'success'))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : '导出失败', 'error'));
  };

  const confirmedCount = state.inventory.filter((item) => item.confirmed).length;

  return (
    <main className="max-w-6xl mx-auto px-3 sm:px-4 lg:px-6 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', letterSpacing: '.12em' }}>MATERIALS · 物料清单</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 800, lineHeight: 1.2 }}>框选物料清单</h1>
        </div>
        <Button variant="secondary" size="sm" className="!border !border-[var(--color-border-strong)]" onClick={blueprintId ? () => navigate(`/blueprints/${blueprintId}/correct`) : finish}>返回</Button>
      </header>

      <section style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xl)', overflow: 'hidden', boxShadow: 'var(--shadow-sm)' }}>
        <div className="flex flex-wrap items-center gap-3 p-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <b>网格</b>
          <label htmlFor="materials-rows">行 <input id="materials-rows" name="materialsRows" style={inputStyle} inputMode="numeric" value={rowsFocused ? rowsText : String(state.rows)} onFocus={() => { setRowsText(String(state.rows)); setRowsFocused(true); }} onChange={(event) => setSize('rows', event.target.value)} onBlur={() => { setRowsFocused(false); setRowsText(String(state.rows)); }} /></label>
          <span>×</span>
          <label htmlFor="materials-cols">列 <input id="materials-cols" name="materialsCols" style={inputStyle} inputMode="numeric" value={colsFocused ? colsText : String(state.cols)} onFocus={() => { setColsText(String(state.cols)); setColsFocused(true); }} onChange={(event) => setSize('cols', event.target.value)} onBlur={() => { setColsFocused(false); setColsText(String(state.cols)); }} /></label>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{state.rows}×{state.cols} = {state.rows * state.cols} 格</span>
          <span className="ml-auto flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRedrawing(true)} disabled={redrawing || state.loading || state.gridLoading} title="在图上按下拖动，画出新的框选区域后重新识别">重新框选</Button>
            <Button variant="secondary" size="sm" onClick={recognize} disabled={state.loading || state.gridLoading || redrawing}>{state.loading ? '识别中…' : '单格识别'}</Button>
            <Button size="sm" onClick={recognizeGrid} disabled={state.loading || state.gridLoading || redrawing}>{state.gridLoading ? '网格识别中…' : '网格识别'}</Button>
          </span>
        </div>
        <MaterialsCanvas imageUrl={input.imageUrl} imageW={input.imageW} imageH={input.imageH} box={state.box} highlightBox={highlightedBox} view={state.view} rows={state.rows} cols={state.cols} stageRef={stageRef} drawing={redrawing} onBox={onBox} onView={onView} onFit={fit} onDrawingEnd={() => setRedrawing(false)} onFocusLeave={onFocusLeave} />
        <div className="flex flex-wrap gap-2 p-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          {blueprintId ? (
            <>
              <Button variant="secondary" size="sm" onClick={exportSamples} disabled={!confirmedCount}>导出已确认样本（{confirmedCount}）</Button>
              <Button variant="secondary" size="sm" className="!border !border-[var(--color-border-strong)]" onClick={() => navigate(`/blueprints/${blueprintId}/correct`)}>完成，返回校正</Button>
              <span className="ml-auto self-center text-xs" style={{ color: saveState === 'error' ? 'var(--color-error)' : saveState === 'saving' ? 'var(--color-text-muted)' : 'var(--color-success)', minWidth: 56 }}>
                {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : saveState === 'saved' ? '已保存' : ''}
              </span>
            </>
          ) : (
            <Button size="sm" onClick={finish}>完成，返回上传页（{state.inventory.length} 项）</Button>
          )}
        </div>
      </section>

      {state.error && <div role="alert" style={{ padding: 12, borderRadius: 'var(--radius-lg)', background: 'var(--color-error-light)', color: 'var(--color-error)' }}>{state.error}</div>}

      <GridPanel
        grid={state.grid}
        loading={state.gridLoading}
        onChange={updateGrid}
        onAddManual={addManual}
        onRetry={retryGridCell}
        onDelete={deleteGridCell}
        onToggleConfirmed={toggleGridConfirmed}
        onReject={rejectCode}
        autoFocusId={autoFocusId}
        onClear={clearGrid}
        onJump={jump}
      />
    </main>
  );
}
