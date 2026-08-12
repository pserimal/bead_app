import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import CorrectionEditorModal from './CorrectionEditorModal';
import type { BlueprintCellDto, ColorDto } from '../types/api';

function cell(row: number, col: number, code: string, correctedCode: string | null = null): BlueprintCellDto {
  return {
    row,
    col,
    code,
    status: 'MAPPED',
    color: { code, name: code, hex: '#FF0000', brand: 'mard' },
    confidence: 0.9,
    correctedCode,
    correctedAt: correctedCode ? '2026-08-09T00:00:00Z' : null,
  };
}

const swatches: ColorDto[] = [
  { code: 'A1', name: '白', hex: '#FAF4C8', brand: 'mard' },
  { code: 'A10', name: '黑', hex: '#000000', brand: 'mard' },
  { code: 'B26', name: '红', hex: '#C0392B', brand: 'mard' },
];
const validCodes = ['A1', 'A10', 'B26'];

function renderModal(overrides: Partial<Parameters<typeof CorrectionEditorModal>[0]> = {}) {
  const cellsByPos = new Map<string, BlueprintCellDto>([
    ['4:7', cell(4, 7, 'A1', 'A10')],
    ['1:2', cell(1, 2, 'B26')],
  ]);
  const props = {
    editor: { keys: ['4:7'] },
    cellsByPos,
    swatches,
    validCodes,
    onClose: vi.fn(),
    onConfirmSet: vi.fn(),
    onConfirmRevert: vi.fn(),
    ...overrides,
  };
  render(<CorrectionEditorModal {...props} />);
  return props;
}

describe('CorrectionEditorModal 交互', () => {
  it('单格模式：显示「换一颗豆」+ 坐标 + 当前有效码（修正优先）', () => {
    renderModal();
    expect(screen.getByText('换一颗豆')).toBeInTheDocument();
    const info = screen.getByText((content, el) => el?.tagName === 'P' && content.includes('第 5 行'));
    expect(info.textContent).toContain('第 8 列');
    expect(info.textContent).toContain('当前 A10');
  });

  it('多格模式：显示「修正 N 格」+ 识别汇总，不显示单格坐标', () => {
    renderModal({ editor: { keys: ['4:7', '1:2'] } });
    expect(screen.getByText('修正 2 格')).toBeInTheDocument();
    expect(screen.queryByText(/第 \d+ 行/)).not.toBeInTheDocument();
  });

  it('输入有效码 + Enter → 提交大写编码', () => {
    const props = renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.change(input, { target: { value: 'a10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onConfirmSet).toHaveBeenCalledWith('A10');
  });

  it('输入过滤下拉候选（编码/名称子串）', () => {
    renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.change(input, { target: { value: 'A1' } });
    const dropdown = within(screen.getByTestId('code-dropdown'));
    expect(dropdown.getByText('A1')).toBeInTheDocument();
    expect(dropdown.getByText('A10')).toBeInTheDocument();
    expect(dropdown.queryByText('B26')).not.toBeInTheDocument();
  });

  it('键盘导航：↓ 选中下拉项 + Enter → 提交选中项', () => {
    const props = renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 选中 A1
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onConfirmSet).toHaveBeenCalledWith('A1');
  });

  it('点击下拉项填入编码', () => {
    renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.focus(input);
    fireEvent.click(screen.getByText('B26'));
    expect((input as HTMLInputElement).value).toBe('B26');
  });

  it('下拉打开时 Esc 先关下拉，再 Esc 关弹窗', () => {
    const props = renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.focus(input);
    expect(screen.getByText('B26')).toBeInTheDocument(); // 下拉已开
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('B26')).not.toBeInTheDocument(); // 下拉关了
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('无效码 Enter 不提交', () => {
    const props = renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.change(input, { target: { value: 'ZZ9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onConfirmSet).not.toHaveBeenCalled();
  });

  it('Esc 关闭（下拉未开时直接关弹窗）', () => {
    const props = renderModal();
    // autoFocus 在 jsdom 会触发 focus → 下拉可能已开；两次 Esc 必然关闭（第一次关下拉，第二次关弹窗）
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('「设为」按钮文案随输入更新', () => {
    renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.change(input, { target: { value: 'A1' } });
    expect(screen.getByText('设为 A1')).toBeInTheDocument();
  });

  it('失焦后下拉保持打开（只在选中编码后收回）', () => {
    renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.focus(input);
    expect(screen.getByTestId('code-dropdown')).toBeInTheDocument();
    fireEvent.blur(input);
    // 失焦不收回——点击弹窗其他区域不会让弹窗"缩一下"
    expect(screen.getByTestId('code-dropdown')).toBeInTheDocument();
    // 选中编码后收回
    const dropdown = within(screen.getByTestId('code-dropdown'));
    fireEvent.click(dropdown.getByText('A1'));
    expect(screen.queryByTestId('code-dropdown')).not.toBeInTheDocument();
  });

  it('输入框 placeholder 显示当前编码（单格模式）', () => {
    renderModal();
    expect((screen.getByLabelText('修正编码') as HTMLInputElement).placeholder).toContain('当前 A10');
  });

  it('下拉项按编码自然排序（A1 < A10 < A2，数字感知）', () => {
    renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.focus(input);
    const dropdown = within(screen.getByTestId('code-dropdown'));
    const codes = Array.from(dropdown.getAllByRole('button')).map((b) => b.querySelector('span')?.textContent ?? '');
    expect(codes).toEqual(['A1', 'A10', 'B26']);
  });

  it('遮罩 mousedown 关闭（不经过 blur 收起下拉的闪烁路径）', () => {
    const props = renderModal();
    const overlay = screen.getByLabelText('关闭').parentElement?.parentElement?.parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(props.onClose).toHaveBeenCalled();
  });
});
