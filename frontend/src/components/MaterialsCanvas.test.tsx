import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MaterialsCanvas from './MaterialsCanvas';
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
});
