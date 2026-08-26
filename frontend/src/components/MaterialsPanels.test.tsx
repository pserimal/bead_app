import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GridPanel } from './MaterialsPanels';
import type { GridCell } from '../hooks/useMaterialsCapture';

const cell = (overrides = {}) => ({
  row: 0,
  col: 0,
  bbox: { x: 0, y: 0, w: 10, h: 10 },
  result: {
    code: 'A1', count: 3, rawCode: 'A1', rawCount: '3',
    codeConfidence: 1, countConfidence: 1, overallConfidence: 1,
    status: 'accepted' as const, candidates: {}, bbox: null, expandedBbox: null,
  },
  code: 'A1', count: '3', loading: false, sourceId: 'grid-0-0',
  ...overrides,
});

const manualCell = (overrides = {}) => cell({
  manual: true,
  row: Number.MAX_SAFE_INTEGER,
  bbox: { x: 0, y: 0, w: 0, h: 0 },
  result: null,
  code: '',
  count: '',
  sourceId: 'manual-1',
  ...overrides,
});

const commonProps = () => ({
  onChange: vi.fn(), onAddManual: vi.fn(), onRetry: vi.fn(), onDelete: vi.fn(),
  onToggleConfirmed: vi.fn(), onClear: vi.fn(), onJump: vi.fn(), onReject: vi.fn(),
  loading: false,
});

const codeInputs = (container: HTMLElement) => [...container.querySelectorAll('input[id^="grid-code-"]')] as HTMLInputElement[];

// 点击面板头部“添加物料”按钮（在所有卡片之外），把焦点移出当前卡片触发提交
const leaveCard = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: '添加物料' }));

// 状态化 harness：onChange 同时记录 mock 调用并真正更新 grid，
// 以模拟页面中 dispatch 更新后重新排序的完整行为。
function Harness({ grid: initialGrid, props }: { grid: GridCell[]; props: ReturnType<typeof commonProps> }) {
  const [grid, setGrid] = useState(initialGrid);
  return (
    <GridPanel
      grid={grid}
      onChange={(index, field, value) => {
        props.onChange(index, field, value);
        setGrid((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
      }}
      onAddManual={props.onAddManual}
      onRetry={props.onRetry}
      onDelete={props.onDelete}
      onToggleConfirmed={props.onToggleConfirmed}
      onClear={props.onClear}
      onJump={props.onJump}
      onReject={props.onReject}
      loading={props.loading}
    />
  );
}

describe('GridPanel', () => {
  it('renders code-sorted results without row and column labels', () => {
    const { getByRole } = render(
      <GridPanel {...commonProps()} grid={[
        cell({ row: 1, col: 0, code: 'C', sourceId: 'grid-1-0' }),
        cell({ row: 0, col: 2, code: 'A', sourceId: 'grid-0-2' }),
        cell({ row: 0, col: 1, code: 'B', sourceId: 'grid-0-1' }),
      ]} />,
    );
    const panel = getByRole('region');
    expect(codeInputs(panel).map((input) => input.value)).toEqual(['A', 'B', 'C']);
    expect(within(panel).queryByText(/行|列/)).not.toBeInTheDocument();
  });

  it('deletes a cell instead of offering re-add', () => {
    const props = commonProps();
    render(<GridPanel {...props} grid={[cell()]} />);
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新添加' })).not.toBeInTheDocument();
  });

  it('offers a manual add action even before recognition', () => {
    const props = commonProps();
    render(<GridPanel {...props} grid={[]} />);
    expect(screen.getByRole('button', { name: '添加物料' })).toBeInTheDocument();
  });

  it('filters cells by confirmed status', async () => {
    const user = userEvent.setup();
    const props = commonProps();
    const { container } = render(
      <GridPanel
        {...props}
        grid={[
          cell({ row: 0, col: 0, code: 'A1', sourceId: 'grid-0-0' }),               // 已确认（accepted）
          cell({ row: 0, col: 1, code: 'B1', sourceId: 'grid-0-1', confirmed: false, result: { code: 'B1', count: 2, rawCode: 'B1', rawCount: '2', codeConfidence: 0.4, countConfidence: 0.4, overallConfidence: 0.4, status: 'needs_confirmation', candidates: {}, bbox: null, expandedBbox: null } }), // 未确认
          cell({ row: 1, col: 0, code: 'C1', sourceId: 'grid-1-0', confirmed: true, result: null }), // 手动勾选已确认
        ]}
      />,
    );

    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'B1', 'C1']);

    // 只看已确认：A1（accepted）、C1（手动勾选）
    await user.click(screen.getByRole('button', { name: '已确认' }));
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'C1']);

    // 只看未确认：B1
    await user.click(screen.getByRole('button', { name: '未确认' }));
    expect(codeInputs(container).map((input) => input.value)).toEqual(['B1']);

    // 全部
    await user.click(screen.getByRole('button', { name: '全部' }));
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'B1', 'C1']);
  });

  it('shows an empty message when the filter matches nothing and disables manual add', async () => {
    const user = userEvent.setup();
    const props = commonProps();
    render(
      <GridPanel
        {...props}
        grid={[
          cell({ row: 0, col: 0, code: 'A1', sourceId: 'grid-0-0' }),
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: '未确认' }));
    expect(screen.getByText('暂无未确认的物料')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加物料' })).toBeDisabled();
  });

  it('shows an empty manual cell first for direct input, then sorts after leaving the card', async () => {
    const user = userEvent.setup();
    const props = commonProps();
    const { container } = render(
      <Harness
        props={props}
        grid={[
          cell({ row: 0, col: 0, code: 'A1', sourceId: 'grid-0-0' }),
          manualCell(),
        ]}
      />,
    );
    // 空手动卡排最前，方便直接输入
    expect(codeInputs(container).map((input) => input.value)).toEqual(['', 'A1']);

    // 输入编码：编辑期间即使切到数量（同一卡内）也不会提交/重排
    const manualInput = codeInputs(container)[0];
    await user.click(manualInput);
    await user.type(manualInput, 'C5');
    await user.tab(); // 编码 → 数量，仍在同一卡
    expect(props.onChange).not.toHaveBeenCalled();
    expect(codeInputs(container).map((input) => input.value)).toEqual(['C5', 'A1']);

    // 离开卡片（点击卡片外的按钮）才提交并按编码归位
    await leaveCard(user);
    expect(props.onChange).toHaveBeenCalledWith(1, 'code', 'C5');
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'C5']);
  });

  it('keeps the visual order stable until focus leaves the card', async () => {
    const user = userEvent.setup();
    const props = commonProps();
    const { container } = render(
      <Harness
        props={props}
        grid={[
          cell({ row: 0, col: 0, code: 'C1', sourceId: 'grid-0-0' }),
          cell({ row: 0, col: 1, code: 'A1', sourceId: 'grid-0-1' }),
          cell({ row: 1, col: 0, code: 'B1', sourceId: 'grid-1-0' }),
        ]}
      />,
    );
    // Code-sorted: A1, B1, C1
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'B1', 'C1']);

    // 聚焦 C1（当前排最后），输入一个会排到最前的编码：编辑期间不跳位
    const inputC = codeInputs(container)[2];
    await user.click(inputC);
    await user.clear(inputC);
    await user.type(inputC, 'A0');
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'B1', 'A0']);
    expect(props.onChange).not.toHaveBeenCalled();

    // 编码 → 数量（同一卡内）：也不提交、不重排
    await user.tab();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'B1', 'A0']);

    // 离开卡片后提交并按新编码排序：A0, A1, B1
    await leaveCard(user);
    expect(props.onChange).toHaveBeenCalledWith(0, 'code', 'A0');
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A0', 'A1', 'B1']);
  });

  it('rejects a code that duplicates an existing cell when leaving the card', async () => {
    const user = userEvent.setup();
    const props = commonProps();
    const { container } = render(
      <Harness
        props={props}
        grid={[
          cell({ row: 0, col: 0, code: 'B', sourceId: 'grid-0-0' }),
          cell({ row: 0, col: 1, code: 'A1', sourceId: 'grid-0-1' }),
        ]}
      />,
    );
    // Code-sorted: A1, B
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'B']);

    // 编辑 B → A1（与已有项重复）：输入期间实时提示，离开卡片时被拒绝并还原
    const inputB = codeInputs(container)[1];
    await user.click(inputB);
    await user.clear(inputB);
    await user.type(inputB, 'A1');
    expect(screen.getByText('与已有编码重复')).toBeInTheDocument();
    await leaveCard(user);

    expect(props.onReject).toHaveBeenCalledWith('A1');
    expect(props.onChange).not.toHaveBeenCalled();
    expect(codeInputs(container).map((input) => input.value)).toEqual(['A1', 'B']);
  });
});