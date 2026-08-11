/**
 * 图纸查看器性能测量脚本（board-viewer-perf）
 *
 * 用法（配合 docs/board-viewer-perf.md）：
 *   1. 前置：三件套启动；Chrome 打开任意 ≥90×158 的蓝图详情页
 *   2. **先 reload 页面**（缩小不重绘设计依赖初始 fit 态；历史缩放会把 drawn.scale 升高，导致低缩放测试不触发重绘）
 *   3. chrome_devtools_emulate: viewport 390x844x3,mobile,touch + cpuThrottlingRate 4（**reload 后节流重置回 1x，必须先 reload 再 emulate**）
 *   4. 把本文件整个内容粘贴到 chrome_devtools_evaluate_script 的 function 参数运行
 *
 * 测量对象（修改这些文件后必跑）：
 *   - frontend/src/lib/boardCanvas.ts
 *   - frontend/src/hooks/useBoardViewer.ts
 *   - frontend/src/pages/BlueprintDetailPage.tsx
 *   - frontend/src/components/ImmersionBoard.tsx
 *
 * 返回 { pass, results }：pass=false 即性能回归，禁止合入。
 * 基线（commit 6f21c81, 90×158=14220 格, 4x CPU 节流）：
 *   低缩放重绘 ~2.7k calls / ~20ms；高缩放重绘 28.4k calls / 95ms；位图 9.6MP；
 *   INP 154ms。修复前：51.9k calls / 446ms，INP 884ms。
 */
async () => {
  const THRESHOLDS = {
    lowZoom: { maxCalls: 5000, maxMs: 80 },   // fit 视图（无编码文字）：基线 ~2.7k/~20ms
    highZoom: { maxCalls: 32000, maxMs: 600 }, // 放大（有文字）：基线 28.4k calls；ms 在 4x 节流下噪声大（实测 95-452ms），calls 为主信号
    viewportMode: { maxCalls: 8000, maxMs: 120 }, // 视口裁剪模式（scale>158%）：只画可见格，基线 ~295 calls / ~1ms
    bitmapMP: 15,                              // 位图面积上限：整图模式基线 9.6MP；视口模式 ≤ 2MP
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const methods = ['fillRect', 'fillText', 'strokeText', 'strokeRect', 'arc', 'moveTo', 'lineTo', 'stroke', 'fill', 'beginPath', 'save', 'restore', 'clip', 'clearRect', 'setTransform', 'drawImage'];


  /**
   * 测单次重绘。触发方式 = 点"放大"按钮（zoomBy 走 React state，比 dispatch dblclick
   * 在 touch 模拟下可靠；dblclick 在 scale>1 时是缩小分支，依赖 fit 起点）。
   * 缩放档位从 wrapper transform 解析（`translate(...) scale(N)`），不依赖页面 span。
   * 关键坑：drawBoard 里 canvas.width 赋值会清除 ctx 实例上的自定义方法（Chrome
   * 行为），所以不能直接 wrap ctx——改为拦截 canvas.getContext：每次 drawBoard
   * 内部调用 getContext 时重新 wrap（链式），取最后一个计数器的增量作为本次重绘
   * 的真实调用数。
   */
  async function measure(canvas, label, warmupClicks, trigger) {
    const scaleOf = () => {
      const t = canvas.parentElement?.style.transform || '';
      const m = t.match(/scale\(([\d.]+)\)/);
      return m ? parseFloat(m[1]) : 0;
    };
    // 预热：放大直到 ≥ targetScale（默认 0.55；视口模式档位传 2）。
    // 注意视口模式下 wrapper transform = none（读不到 scale）→ scaleOf 返回 0 → 退化为固定次数。
    const targetScale = label.includes('视口') ? 2 : 0.55;
    for (let i = 0; i < warmupClicks; i += 1) {
      if (warmupClicks > 0 && scaleOf() >= targetScale) break;
      trigger();
      await sleep(1300); // 预热：静默带到位（不计数）
    }
    const counters = [];
    const origGetContext = canvas.getContext.bind(canvas);
    canvas.getContext = (type) => {
      const ctx = origGetContext(type);
      const s = { calls: 0, ms: 0, byType: {} };
      counters.push(s);
      for (const m of methods) {
        const orig = ctx[m].bind(ctx);
        ctx[m] = (...a) => {
          const t = performance.now();
          const r = orig(...a);
          s.ms += performance.now() - t;
          s.calls += 1;
          s.byType[m] = (s.byType[m] || 0) + 1;
          return r;
        };
      }
      return ctx;
    };
    trigger();
    await sleep(1300); // 单次重绘（150ms 防抖 + rAF）
    canvas.getContext = origGetContext;
    // 本次窗口增量 = 最后一个计数器 − 链上上一个计数器（链式 wrap 会累积）
    const last = counters[counters.length - 1];
    const prev = counters[counters.length - 2];
    const sub = (a, b) => {
      const out = {};
      for (const k of Object.keys(a)) out[k] = a[k] - (b?.[k] ?? 0);
      return out;
    };
    const calls = last.calls - (prev?.calls ?? 0);
    return {
      label,
      calls,
      ms: +(last.ms - (prev?.ms ?? 0)).toFixed(1),
      byType: sub(last.byType, prev?.byType),
      bitmapMP: +((canvas.width * canvas.height) / 1e6).toFixed(1),
      cssSize: `${canvas.style.width}x${canvas.style.height}`,
    };
  }

  const findCanvas = (ariaLabel) => document.querySelector(`canvas[aria-label="${ariaLabel}"]`);
  const findButton = (text) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === text);

  const results = [];
  let pass = true;

  // ── 详情页（触发 = 点"放大"按钮，zoomBy 走 React state，最可靠）──
  const detailCanvas = findCanvas('彩色拼豆图纸');
  if (!detailCanvas) return { error: '详情页 canvas 未找到（页面加载完成了吗？）' };
  // 归位 fit 视图（scale 由页面决定，通常 <0.35）
  const fitBtn = findButton('适应窗口');
  if (fitBtn) fitBtn.click();
  await sleep(1200);
  const detailTrigger = () => {
    const btn = document.querySelector('button[aria-label="放大"]');
    if (btn) btn.click();
  };
  // 低缩放重绘（fit → 1 次放大，仍 <0.35 → 无编码文字）
  results.push(await measure(detailCanvas, '详情-低缩放', 0, detailTrigger));
  // 高缩放重绘（预热到 ≥55%，再测 1 次 → 有编码文字）
  results.push(await measure(detailCanvas, '详情-高缩放', 4, detailTrigger));
  // 视口模式重绘（预热到 >158% → 位图 = 视口大小，只画可见格；拖拽每帧成本）
  // 注意：预热次数需避开 MAX_ZOOM=8 封顶（封顶后缩放无变化不重绘）；4 次 × 1.25 从 ~65% → 159%
  results.push(await measure(detailCanvas, '详情-视口模式', 4, detailTrigger));

  // ── 沉浸模式（无缩放按钮，触发 = dblclick；fit 19% 出发双击永远放大，语义安全）──
  const immersionBtn = findButton('沉浸模式');
  if (immersionBtn) {
    immersionBtn.click();
    await sleep(1500);
    const immCanvas = findCanvas('拼豆图纸全屏预览');
    if (immCanvas) {
      const immTrigger = () => immCanvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 195, clientY: 300 }));
      results.push(await measure(immCanvas, '沉浸-低缩放', 0, immTrigger));
      results.push(await measure(immCanvas, '沉浸-高缩放', 3, immTrigger));
      // 沉浸模式视口档位：dblclick 在 >100% 时是缩小，wheel 1.12× 太慢 → 复合预热
      // （dblclick×4 到 124% + wheel×3 到 174% 跨过 158% 阈值），然后测 1 次 wheel
      const immViewportTrigger = () => immCanvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 195, clientY: 300 }));
      for (let i = 0; i < 4; i += 1) { immTrigger(); await sleep(1300); }
      for (let i = 0; i < 3; i += 1) { immViewportTrigger(); await sleep(1300); }
      results.push(await measure(immCanvas, '沉浸-视口模式', 0, immViewportTrigger));
    } else {
      results.push({ label: '沉浸-未进入', error: '沉浸模式 canvas 未出现' });
      pass = false;
    }
    // 退出沉浸，恢复页面
    const exitBtn = findButton('退出沉浸 ✕');
    if (exitBtn) exitBtn.click();
  }

  // ── 判定 ──
  for (const r of results) {
    if (r.error) continue;
    const isLow = r.label.includes('低缩放');
    const isVp = r.label.includes('视口');
    const t = isLow ? THRESHOLDS.lowZoom : isVp ? THRESHOLDS.viewportMode : THRESHOLDS.highZoom;
    const okCalls = r.calls <= t.maxCalls;
    const okMs = r.ms <= t.maxMs;
    const okBitmap = r.bitmapMP <= THRESHOLDS.bitmapMP;
    r.pass = okCalls && okMs && okBitmap;
    r.verdict = `${r.pass ? 'PASS' : 'FAIL'} (calls ${r.calls}/${t.maxCalls}, ms ${r.ms}/${t.maxMs}, bitmap ${r.bitmapMP}MP/${THRESHOLDS.bitmapMP}MP)`;
    if (!r.pass) pass = false;
  }

  return { pass, thresholds: THRESHOLDS, results };
}
