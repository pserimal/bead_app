import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MaterialsCanvas, { ZOOM_FACTOR } from './MaterialsCanvas';
import type { Box, View } from '../hooks/useMaterialsCapture';

const box: Box = { x: 10, y: 10, w: 80, h: 60 };
const view: View = { scale: 2, x: 10, y: 20 };

function renderCanvas(onView = vi.fn(), onFit = vi.fn(), currentView = view) {
  const stageRef = createRef<HTMLDivElement>();
  render(
    <MaterialsCanvas
      imageUrl="blob:test"
      imageW={100}
      imageH={80}
      box={box}
      view={currentView}
      rows={3}
      cols={8}
      stageRef={stageRef}
      onBox={vi.fn()}
      onView={onView}
      onFit={onFit}
    />,
  );
  const stage = screen.getByRole('application');
  Object.defineProperty(stage, 'setPointerCapture', { value: vi.fn() });
  // jsdom rect 默认 0×0；mock 一个真实视口尺寸（clamp 依赖 stage 大小）
  Object.defineProperty(stage, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }),
  });
  return stage;
}

describe('MaterialsCanvas interactions', () => {
  it('notifies focus leave only when focus moves outside the canvas', () => {
    const onFocusLeave = vi.fn();
    const stageRef = createRef<HTMLDivElement>();
    render(
      <MaterialsCanvas
        imageUrl="blob:test"
        imageW={100}
        imageH={80}
        box={box}
        view={view}
        rows={3}
        cols={8}
        stageRef={stageRef}
        onBox={vi.fn()}
        onView={vi.fn()}
        onFit={vi.fn()}
        onFocusLeave={onFocusLeave}
      />,
    );
    const stage = screen.getByRole('application') as HTMLElement;
    const zoomIn = screen.getByRole('button', { name: '放大' });

    // 焦点移到画布内部的缩放按钮 → 不算离开
    fireEvent.blur(stage, { relatedTarget: zoomIn });
    expect(onFocusLeave).not.toHaveBeenCalled();

    // 焦点移到画布外部 → 触发离开
    fireEvent.blur(stage, { relatedTarget: document.body });
    expect(onFocusLeave).toHaveBeenCalledTimes(1);
  });

  it('pans by the pointer client delta even when movementX/Y are zero', async () => {
    const onView = vi.fn();
    const stage = renderCanvas(onView);

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, {
      pointerId: 1,
      clientX: 160,
      clientY: 145,
      movementX: 0,
      movementY: 0,
    });
    // rAF 节流：等待下一帧应用
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    expect(onView).toHaveBeenLastCalledWith({ scale: 2, x: 70, y: 65 });
  });

  it('uses the percentage control to restore the fitted view', () => {
    const onFit = vi.fn();
    const stage = renderCanvas(vi.fn(), onFit);

    fireEvent.click(screen.getByRole('button', { name: '恢复适应窗口' }));

    expect(onFit).toHaveBeenCalledTimes(1);
    expect(stage).toBeInTheDocument();
  });

  it('prevents wheel zoom from triggering the page default scroll', () => {
    const stage = renderCanvas();
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });

    const dispatchResult = stage.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(dispatchResult).toBe(false);
  });

  it('returns to the original scale after one manual zoom-in and zoom-out', () => {
    function Harness() {
      const [currentView, setCurrentView] = useState<View>({ scale: 0.1, x: 0, y: 0 });
      const stageRef = createRef<HTMLDivElement>();
      return (
        <MaterialsCanvas
          imageUrl="blob:test"
          imageW={100}
          imageH={80}
          box={box}
          view={currentView}
          rows={3}
          cols={8}
          stageRef={stageRef}
          onBox={vi.fn()}
          onView={setCurrentView}
          onFit={vi.fn()}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    fireEvent.click(screen.getByRole('button', { name: '缩小' }));

    expect(screen.getByRole('button', { name: '恢复适应窗口' })).toHaveTextContent('10%');
  });

  it('drawing mode: drag draws a new box and exits drawing on pointer up', async () => {
    const onBox = vi.fn();
    const onDrawingEnd = vi.fn();
    function DrawingHarness() {
      const [drawing, setDrawing] = useState(true);
      const stageRef = createRef<HTMLDivElement>();
      return (
        <MaterialsCanvas
          imageUrl="blob:test"
          imageW={100}
          imageH={80}
          box={box}
          view={view} /* scale=2, x=10, y=20 */
          rows={3}
          cols={8}
          stageRef={stageRef}
          drawing={drawing}
          onBox={(b) => {
            onBox(b);
          }}
          onView={vi.fn()}
          onFit={vi.fn()}
          onDrawingEnd={() => {
            onDrawingEnd();
            setDrawing(false);
          }}
        />
      );
    }

    render(<DrawingHarness />);
    const stage = screen.getByRole('application') as HTMLElement;
    Object.defineProperty(stage, 'setPointerCapture', { value: vi.fn() });

    // 画框模式提示可见，四角手柄隐藏
    expect(screen.getByText(/在图上按下并拖动/)).toBeInTheDocument();
    expect(stage.querySelectorAll('[data-box-handle]')).toHaveLength(0);

    // jsdom rect = 全 0：point = (clientX - view.x) / scale；起点 (30,40) → (10,10)，终点 (90,60) → (40,20)
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 30, clientY: 40 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 90, clientY: 60 });
    // rAF 节流：等待应用
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(onBox).toHaveBeenLastCalledWith({ x: 10, y: 10, w: 30, h: 10 });

    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(onDrawingEnd).toHaveBeenCalledTimes(1);
    // 退出画框模式：提示消失、手柄恢复
    expect(screen.queryByText(/在图上按下并拖动/)).not.toBeInTheDocument();
    expect(stage.querySelectorAll('[data-box-handle]')).toHaveLength(4);
  });

  it('drawing mode: a click without drag does not exit drawing mode', async () => {
    const onDrawingEnd = vi.fn();
    const stageRef = createRef<HTMLDivElement>();
    render(
      <MaterialsCanvas
        imageUrl="blob:test"
        imageW={100}
        imageH={80}
        box={box}
        view={view}
        rows={3}
        cols={8}
        stageRef={stageRef}
        drawing
        onBox={vi.fn()}
        onView={vi.fn()}
        onFit={vi.fn()}
        onDrawingEnd={onDrawingEnd}
      />,
    );
    const stage = screen.getByRole('application') as HTMLElement;
    Object.defineProperty(stage, 'setPointerCapture', { value: vi.fn() });

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 30, clientY: 40 });
    fireEvent.pointerUp(stage, { pointerId: 1 });

    expect(onDrawingEnd).not.toHaveBeenCalled();
  });

  it('pinches to zoom around the midpoint of two fingers', async () => {
    const onView = vi.fn();
    // view 在图片居中位置（scale 2 → 屏幕 200×160，stage 800×600，clamp 界 [0,600]×[0,440]）
    const stage = renderCanvas(onView, vi.fn(), { scale: 2, x: 300, y: 200 });

    // 双指按下：相距 100px，中点 (150, 100)
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 200, clientY: 100 });
    // 第二指右移：距离 150px → scale = 2 × (150/100) = 3，中点变为 (175, 100)
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 250, clientY: 100 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    // scale = 3；ratio = 1.5
    // x' = midX − (midX − x)×ratio = 175 − (175−300)×1.5 = 362.5
    // y' = midY − (midY − y)×ratio = 100 − (100−200)×1.5 = 250
    expect(onView).toHaveBeenLastCalledWith({ scale: 3, x: 362.5, y: 250 });
  });

  it('pinch overrides single-finger pan and lifting one finger restores pan', async () => {
    const onView = vi.fn();
    const stage = renderCanvas(onView);

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 200, clientY: 100 });
    // 两指同向移动（整只手平移）：距离仍 100px → scale 不变，且不产生单指 pan 增量
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 150, clientY: 150 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 250, clientY: 150 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const pinchCall = onView.mock.lastCall?.[0] as View;
    expect(pinchCall.scale).toBe(2);
    expect(pinchCall.x).toBe(10);
    expect(pinchCall.y).toBe(20);

    // 抬起一指 → 重新按下单指 → 恢复平移
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 250, clientY: 150 });
    onView.mockClear();
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 150, clientY: 150 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 200, clientY: 170 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    // 拖 delta (50, 20)：基于当前 props view (scale 2, x 10, y 20)
    expect(onView).toHaveBeenLastCalledWith({ scale: 2, x: 60, y: 40 });
  });

  it('button zoom anchors the viewport center, not the origin', async () => {
    // stage 800×600，中心 (400,300)；view = { scale: 4, x: 300, y: 200 }（图片 400×320，clamp 界 [0,400]×[0,280]）
    // 放大：scale 4→4.48，ratio 1.12；x' = 400 − (400−300)×1.12 = 288, y' = 300 − (300−200)×1.12 = 188
    const onView = vi.fn();
    renderCanvas(onView, vi.fn(), { scale: 4, x: 300, y: 200 });

    fireEvent.click(screen.getByRole('button', { name: '放大' }));

    const call = onView.mock.lastCall?.[0] as View;
    expect(call.scale).toBeCloseTo(4 * ZOOM_FACTOR);
    expect(call.x).toBeCloseTo(288);
    expect(call.y).toBeCloseTo(188);
  });

  it('pan clamps at the image edge so the image cannot leave the viewport', async () => {
    const onView = vi.fn();
    const stage = renderCanvas(onView); // view scale=2, x=10, y=20; image 100x80 → 屏幕 200x160，stage 800×600
    // 允许范围：x ∈ [0, 800−200]=[0,600]，y ∈ [0, 600−160]=[0,440]

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 10000, clientY: 10000 }); // 向右下猛拖
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const call = onView.mock.lastCall?.[0] as View;
    expect(call.x).toBe(600); // 图片左缘 600：右缘 800 = stage 右缘（贴右缘）
    expect(call.y).toBe(440);
  });

  it('pan clamps at the opposite edge (top-left direction)', async () => {
    const onView = vi.fn();
    const stage = renderCanvas(onView);

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: -10000, clientY: -10000 }); // 向左上猛拖
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const call = onView.mock.lastCall?.[0] as View;
    expect(call.x).toBe(0); // clamp 到左边界：图片左缘 0
    expect(call.y).toBe(0);
  });

  it('soft boundary: a zoomed-in image larger than the viewport can be dragged to leave only a quarter visible', async () => {
    const onView = vi.fn();
    // scale=10 → 图片 1000×800 屏幕像素，大于 stage 800×600。
    // 软边界允许范围（margin = stage 的 1/4 = 200/150）：
    //   x ∈ [−(1000−800)−200, 200] = [−400, 200]
    //   y ∈ [−(800−600)−150, 150] = [−350, 150]
    const stage = renderCanvas(onView, vi.fn(), { scale: 10, x: 0, y: 0 });

    // 向左上猛拖：图片左缘/上缘应能拖出视口（软边界允许）
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: -10000, clientY: -10000 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    let call = onView.mock.lastCall?.[0] as View;
    expect(call.x).toBe(-400); // 图右缘 600 = stage 右缘 − 余量 200（只剩 200px 在图内可见余量）
    expect(call.y).toBe(-350); // 图下缘 450 = stage 下缘 − 余量 150

    // 向右下猛拖：图左缘/上缘最多到视口 1/4 处，不会把图拖到彻底看不见（总留 1/4 余量）
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 10000, clientY: 10000 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    call = onView.mock.lastCall?.[0] as View;
    expect(call.x).toBe(200); // 图左缘最多 200 = margin
    expect(call.y).toBe(150); // 图顶缘最多 150 = margin
  });

  it('soft boundary only relaxes when the image is larger than the viewport: small image still clamps fully', async () => {
    const onView = vi.fn();
    // scale=1 → 图片 100×80，远小于 stage 800×600 → 维持夹紧行为（x∈[0,700], y∈[0,520]）
    const stage = renderCanvas(onView, vi.fn(), { scale: 1, x: 0, y: 0 });

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: -10000, clientY: -10000 }); // 向左上猛拖
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect((onView.mock.lastCall?.[0] as View).x).toBe(0); // 不能拖出左边界

    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 10000, clientY: 10000 }); // 向右下猛拖
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const call = onView.mock.lastCall?.[0] as View;
    expect(call.x).toBe(700); // 图左缘最多 700 = stage 800 − 图 100（贴右缘，不能留空隙出右缘）
    expect(call.y).toBe(520); // 600 − 80
  });

  it('stale pointer from a lost pointerup does not trap single-finger pan', async () => {
    const onView = vi.fn();
    const stage = renderCanvas(onView);

    // 双指捏合（pointerId 1 + 2）
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 250, clientY: 100 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // 只剩一根手指的 up（另一根 up 丢失）——lostpointercapture 兜底清理
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.lostPointerCapture(stage, { pointerId: 2, clientX: 250, clientY: 100 });

    // 重新单指按下并拖动 → 应正常平移（不是 pinch）
    onView.mockClear();
    fireEvent.pointerDown(stage, { pointerId: 3, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(stage, { pointerId: 3, clientX: 360, clientY: 230 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const call = onView.mock.lastCall?.[0] as View;
    expect(call.scale).toBe(2); // 无缩放——纯平移
    expect(call.x).toBe(70); // 300→360：x = 10 + 60
    expect(call.y).toBe(50); // 200→230：y = 20 + 30
  });

  it('pinch in drawing mode suspends the in-progress box and zooms', async () => {
    const onBox = vi.fn();
    const onView = vi.fn();
    const stageRef = createRef<HTMLDivElement>();
    render(
      <MaterialsCanvas
        imageUrl="blob:test"
        imageW={100}
        imageH={80}
        box={box}
        view={view}
        rows={3}
        cols={8}
        stageRef={stageRef}
        drawing
        onBox={onBox}
        onView={onView}
        onFit={vi.fn()}
      />,
    );
    const stage = screen.getByRole('application') as HTMLElement;
    Object.defineProperty(stage, 'setPointerCapture', { value: vi.fn() });

    // 单指开始画框 → 第二指按下进入捏合：挂起画框并缩放
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 30, clientY: 40 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 60, clientY: 50 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(onBox).toHaveBeenCalled(); // 画框已开始
    const boxCalls = onBox.mock.calls.length;

    // 第二指按下 + 张开：进入捏合，画框挂起（onBox 不再增长）
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 130, clientY: 40 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 180, clientY: 40 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(onBox.mock.calls.length).toBe(boxCalls); // 画框被挂起
    const zoomCall = onView.mock.lastCall?.[0] as View;
    expect(zoomCall.scale).toBeGreaterThan(2); // 缩放生效
  });
});
