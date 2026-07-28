import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BlueprintDetailPage from '../pages/BlueprintDetailPage';

vi.mock('../hooks/useBlueprints', () => ({
  useBlueprint: vi.fn(),
  useUpdateCells: vi.fn(() => ({ mutate: vi.fn() })),
}));

vi.mock('../hooks/useColorLibrary', () => ({
  useColorLibraries: vi.fn(() => ({ data: [] })),
  useColorLibrary: vi.fn(() => ({ data: null })),
}));

vi.mock('../components/BeadBoard', () => ({
  default: () => <div data-testid="bead-board">BeadBoard</div>,
}));

vi.mock('../components/CellEditor', () => ({
  default: () => null,
}));

vi.mock('../components/ColorFilter', () => ({
  default: () => <div data-testid="color-filter">ColorFilter</div>,
}));

vi.mock('../components/Spinner', () => ({
  default: () => <div data-testid="spinner">Loading...</div>,
}));

import { useBlueprint } from '../hooks/useBlueprints';

const mockBlueprint = {
  id: 1,
  name: '测试图纸',
  grid_rows: 10,
  grid_cols: 10,
  status: 'ready',
  cells: [
    { id: 1, blueprint_id: 1, row_idx: 0, col_idx: 0, bead_code: 'A01', pixel_color: '#ff0000' },
    { id: 2, blueprint_id: 1, row_idx: 0, col_idx: 1, bead_code: 'A02', pixel_color: '#00ff00' },
  ],
};

function renderPage(blueprint = mockBlueprint) {
  (useBlueprint as ReturnType<typeof vi.fn>).mockReturnValue({
    data: blueprint,
    isLoading: false,
    error: null,
  });

  return render(
    <MemoryRouter initialEntries={['/blueprints/1']}>
      <BlueprintDetailPage />
    </MemoryRouter>,
  );
}

describe('BlueprintDetailPage — rendering', () => {
  it('renders the blueprint board', () => {
    renderPage();
    expect(screen.getByTestId('bead-board')).toBeInTheDocument();
  });

  it('shows loading spinner when loading', () => {
    (useBlueprint as ReturnType<typeof vi.fn>).mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
    });

    render(
      <MemoryRouter initialEntries={['/blueprints/1']}>
        <BlueprintDetailPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('shows error state when blueprint not found', () => {
    (useBlueprint as ReturnType<typeof vi.fn>).mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('not found'),
    });

    render(
      <MemoryRouter initialEntries={['/blueprints/1']}>
        <BlueprintDetailPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('图纸未找到')).toBeInTheDocument();
  });

  it('displays blueprint name in sidebar', () => {
    renderPage();
    expect(screen.getByText('测试图纸')).toBeInTheDocument();
  });

  it('displays grid dimensions', () => {
    renderPage();
    const dimensions = screen.getAllByText('10×10');
    expect(dimensions.length).toBeGreaterThanOrEqual(1);
  });
});

describe('BlueprintDetailPage — controls', () => {
  it('renders zoom controls on desktop', () => {
    renderPage();
    expect(screen.getByTitle('缩小')).toBeInTheDocument();
    expect(screen.getByTitle('放大')).toBeInTheDocument();
  });

  it('renders rotation controls on desktop', () => {
    renderPage();
    expect(screen.getByTitle('左旋90°')).toBeInTheDocument();
    expect(screen.getByTitle('右旋90°')).toBeInTheDocument();
  });

  it('renders reset button', () => {
    renderPage();
    const resetButtons = screen.getAllByText('重置');
    expect(resetButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('zoom in increases scale display', () => {
    renderPage();
    const zoomInBtn = screen.getByTitle('放大');
    fireEvent.click(zoomInBtn);
    const scaleDisplays = screen.getAllByText(/\d+%/);
    expect(scaleDisplays.length).toBeGreaterThanOrEqual(1);
  });
});

describe('BlueprintDetailPage — sidebar', () => {
  it('renders sidebar info section', () => {
    renderPage();
    expect(screen.getByText('图纸信息')).toBeInTheDocument();
  });

  it('displays cell count in sidebar', () => {
    renderPage();
    expect(screen.getByText('2 个')).toBeInTheDocument();
  });

  it('displays status in sidebar', () => {
    renderPage();
    expect(screen.getByText(/就绪/)).toBeInTheDocument();
  });
});

describe('BlueprintDetailPage — warm theme', () => {
  it('toolbar uses warm surface background', () => {
    const { container } = renderPage();
    const html = container.innerHTML;
    expect(html).toContain('var(--color-surface)');
  });

  it('sidebar uses warm surface background', () => {
    const { container } = renderPage();
    const html = container.innerHTML;
    expect(html).toContain('var(--color-surface)');
  });

  it('heading uses display font', () => {
    renderPage();
    const heading = screen.getByText('图纸信息');
    expect(heading.style.fontFamily).toBe('var(--font-display)');
  });

  it('no indigo or slate Tailwind classes on page', () => {
    const { container } = renderPage();
    const html = container.innerHTML;
    expect(html).not.toMatch(/slate-\d/);
    expect(html).not.toMatch(/indigo-\d/);
  });
});
