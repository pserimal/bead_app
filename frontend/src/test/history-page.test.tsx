import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import HistoryPage from '../pages/HistoryPage';

vi.mock('../hooks/useBlueprints', () => ({
  useBlueprints: vi.fn(),
  useDeleteBlueprint: vi.fn(() => ({ mutateAsync: vi.fn() })),
}));

import { useBlueprints } from '../hooks/useBlueprints';
const mockUseBlueprints = vi.mocked(useBlueprints);

function renderHistory(path = '/blueprints') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HistoryPage />
    </MemoryRouter>,
  );
}

describe('HistoryPage — loading state', () => {
  it('renders skeleton cards when loading', () => {
    mockUseBlueprints.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    const { container } = renderHistory();
    const skeletons = container.querySelectorAll('.skeleton-shimmer');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it('displays page title during loading', () => {
    mockUseBlueprints.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    expect(screen.getByText('图纸列表')).toBeInTheDocument();
  });
});

describe('HistoryPage — empty state', () => {
  it('renders empty state message', () => {
    mockUseBlueprints.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    expect(screen.getByText('还没有图纸')).toBeInTheDocument();
    expect(screen.getByText('去上传一张图纸')).toBeInTheDocument();
  });

  it('uses display font for empty state heading', () => {
    mockUseBlueprints.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    const heading = screen.getByText('还没有图纸');
    expect(heading.style.fontFamily).toBe('var(--font-display)');
  });
});

describe('HistoryPage — error state', () => {
  it('renders error display on failure', () => {
    mockUseBlueprints.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('fail'),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    expect(screen.getByText('加载图纸列表失败')).toBeInTheDocument();
  });
});

describe('HistoryPage — card rendering', () => {
  it('renders blueprint cards', () => {
    mockUseBlueprints.mockReturnValue({
      data: {
        items: [
          {
            id: 1,
            name: 'Test Blueprint',
            grid_rows: 10,
            grid_cols: 15,
            status: 'ready',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    expect(screen.getByText('Test Blueprint')).toBeInTheDocument();
    expect(screen.getByText('10×15')).toBeInTheDocument();
    expect(screen.getByText('就绪')).toBeInTheDocument();
  });

  it('shows unnamed label when name is empty', () => {
    mockUseBlueprints.mockReturnValue({
      data: {
        items: [
          {
            id: 1,
            name: '',
            grid_rows: 5,
            grid_cols: 5,
            status: 'ready',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    expect(screen.getByText('未命名')).toBeInTheDocument();
  });
});

describe('HistoryPage — warm theme compliance', () => {
  it('does not use indigo or slate Tailwind classes on elements', () => {
    mockUseBlueprints.mockReturnValue({
      data: {
        items: [
          {
            id: 1,
            name: 'Test',
            grid_rows: 5,
            grid_cols: 5,
            status: 'ready',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    const { container } = renderHistory();
    const allElements = container.querySelectorAll('*');
    for (const el of allElements) {
      const classes = el.className;
      if (typeof classes === 'string') {
        expect(classes).not.toMatch(/\bslate\b/);
        expect(classes).not.toMatch(/\bindigo\b/);
      }
    }
  });

  it('uses display font on page title', () => {
    mockUseBlueprints.mockReturnValue({
      data: { items: [], total: 0 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    const title = screen.getByText('图纸列表');
    expect(title.style.fontFamily).toBe('var(--font-display)');
  });

  it('uses warm CSS variables on card elements', () => {
    mockUseBlueprints.mockReturnValue({
      data: {
        items: [
          {
            id: 1,
            name: 'Warm Card',
            grid_rows: 8,
            grid_cols: 10,
            status: 'ready',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBlueprints>);

    renderHistory();
    const card = screen.getByTestId('blueprint-card');
    expect(card.style.border).toContain('var(--color-border)');
    expect(card.style.background).toContain('var(--color-surface)');
  });
});
