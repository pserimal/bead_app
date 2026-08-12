import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(screen.getByText(/第 5 行 · 第 8 列/)).toBeInTheDocument();
    expect(screen.getByText('A10')).toBeInTheDocument();
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

  it('无效码 Enter 不提交', () => {
    const props = renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.change(input, { target: { value: 'ZZ9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onConfirmSet).not.toHaveBeenCalled();
  });

  it('Esc 关闭', () => {
    const props = renderModal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('点击豆子填入编码并聚焦输入框', () => {
    renderModal();
    fireEvent.click(screen.getByLabelText('B26'));
    expect((screen.getByLabelText('修正编码') as HTMLInputElement).value).toBe('B26');
  });

  it('「设为」按钮文案随输入更新', () => {
    renderModal();
    const input = screen.getByLabelText('修正编码');
    fireEvent.change(input, { target: { value: 'A1' } });
    expect(screen.getByText('设为 A1')).toBeInTheDocument();
  });
});
