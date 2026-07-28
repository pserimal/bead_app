import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ColorLibraryPage from '../pages/ColorLibraryPage';

const mockToast = vi.fn();
vi.mock('../components/ToastContext', () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockMutateAsync = vi.fn().mockResolvedValue({});
vi.mock('../hooks/useColorLibrary', () => ({
  useColorLibraries: vi.fn(),
  useColorLibrary: vi.fn(),
  useAddColorEntry: vi.fn(),
  useUpdateColorEntry: vi.fn(),
  useDeleteColorEntry: vi.fn(),
}));

import {
  useColorLibraries,
  useColorLibrary,
  useAddColorEntry,
  useUpdateColorEntry,
  useDeleteColorEntry,
} from '../hooks/useColorLibrary';

const mockUseColorLibraries = vi.mocked(useColorLibraries);
const mockUseColorLibrary = vi.mocked(useColorLibrary);
const mockUseAddColorEntry = vi.mocked(useAddColorEntry);
const mockUseUpdateColorEntry = vi.mocked(useUpdateColorEntry);
const mockUseDeleteColorEntry = vi.mocked(useDeleteColorEntry);

const mockLibraries = [
  { id: 1, name: '默认色库' },
  { id: 2, name: '自定义色库' },
];

const mockLibraryData = {
  id: 1,
  name: '默认色库',
  entries: [
    { id: 101, code: 'H1', color_hex: '#ff0000', color_name: '红色', sort_order: 1 },
    { id: 102, code: 'H2', color_hex: '#00ff00', color_name: '绿色', sort_order: 2 },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ColorLibraryPage />
    </QueryClientProvider>,
  );
}

describe('ColorLibraryPage — renders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({});
    mockUseAddColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
    mockUseUpdateColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
    mockUseDeleteColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
  });

  it('shows spinner while loading', () => {
    mockUseColorLibraries.mockReturnValue({ data: undefined, isLoading: true } as any);
    mockUseColorLibrary.mockReturnValue({ data: undefined } as any);
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders page heading with display font', () => {
    mockUseColorLibraries.mockReturnValue({ data: mockLibraries, isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    renderPage();
    const heading = screen.getByTestId('page-heading');
    expect(heading).toBeInTheDocument();
    expect(heading.textContent).toBe('颜色库管理');
    expect(heading.style.fontFamily).toBe('var(--font-display)');
  });

  it('renders entry rows with color swatches', () => {
    mockUseColorLibraries.mockReturnValue({ data: mockLibraries, isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    renderPage();
    expect(screen.getByTestId('entry-row-101')).toBeInTheDocument();
    expect(screen.getByTestId('entry-row-102')).toBeInTheDocument();
    const swatch = screen.getByTestId('color-swatch-101');
    expect(swatch.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  it('does not use indigo or slate classes', () => {
    mockUseColorLibraries.mockReturnValue({ data: mockLibraries, isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    const { container } = renderPage();
    const html = container.innerHTML;
    expect(html).not.toMatch(/indigo-/);
    expect(html).not.toMatch(/slate-/);
  });

  it('uses CSS variables for theming', () => {
    mockUseColorLibraries.mockReturnValue({ data: mockLibraries, isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    renderPage();
    const wrapper = screen.getByTestId('entries-table-wrapper');
    expect(wrapper.style.backgroundColor).toBe('var(--color-surface)');
    expect(wrapper.style.border).toContain('var(--color-border)');
  });
});

describe('ColorLibraryPage — library tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({});
    mockUseAddColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
    mockUseUpdateColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
    mockUseDeleteColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
  });

  it('renders library tabs when multiple libraries exist', () => {
    mockUseColorLibraries.mockReturnValue({ data: mockLibraries, isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    renderPage();
    expect(screen.getByTestId('library-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('library-tab-1')).toBeInTheDocument();
    expect(screen.getByTestId('library-tab-2')).toBeInTheDocument();
  });

  it('does not render tabs with single library', () => {
    mockUseColorLibraries.mockReturnValue({ data: [mockLibraries[0]], isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    renderPage();
    expect(screen.queryByTestId('library-tabs')).not.toBeInTheDocument();
  });

  it('clicking a tab applies active accent styling', () => {
    mockUseColorLibraries.mockReturnValue({ data: mockLibraries, isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    renderPage();
    const tab1 = screen.getByTestId('library-tab-1');
    expect(tab1.style.backgroundColor).toBe('var(--color-accent)');
    expect(tab1.style.color).toBe('var(--color-text-inverse)');
    const tab2 = screen.getByTestId('library-tab-2');
    expect(tab2.style.backgroundColor).toBe('var(--color-bg-secondary)');
  });
});

describe('ColorLibraryPage — add/edit form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({});
    mockUseColorLibraries.mockReturnValue({ data: mockLibraries, isLoading: false } as any);
    mockUseColorLibrary.mockReturnValue({ data: mockLibraryData } as any);
    mockUseAddColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
    mockUseUpdateColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
    mockUseDeleteColorEntry.mockReturnValue({ mutateAsync: mockMutateAsync } as any);
  });

  it('opens add modal when clicking add button', () => {
    renderPage();
    fireEvent.click(screen.getByText('+ 添加颜色'));
    expect(screen.getByTestId('color-form')).toBeInTheDocument();
    expect(screen.getByTestId('input-code')).toBeInTheDocument();
    expect(screen.getByTestId('input-name')).toBeInTheDocument();
    expect(screen.getByTestId('input-hex')).toBeInTheDocument();
  });

  it('form inputs use warm border styling', () => {
    renderPage();
    fireEvent.click(screen.getByText('+ 添加颜色'));
    const codeInput = screen.getByTestId('input-code');
    expect(codeInput.style.border).toContain('var(--color-border)');
  });

  it('code input transforms to uppercase', () => {
    renderPage();
    fireEvent.click(screen.getByText('+ 添加颜色'));
    const codeInput = screen.getByTestId('input-code');
    fireEvent.change(codeInput, { target: { value: 'abc' } });
    expect(codeInput).toHaveValue('ABC');
  });

  it('opens edit modal with pre-filled values', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('edit-btn-101'));
    expect(screen.getByTestId('input-code')).toHaveValue('H1');
    expect(screen.getByTestId('input-name')).toHaveValue('红色');
    expect(screen.getByTestId('input-hex')).toHaveValue('#ff0000');
  });

  it('delete button opens confirmation modal', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('delete-btn-101'));
    expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();
  });

  it('delete confirmation uses danger variant button', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('delete-btn-101'));
    const deleteBtn = screen.getByTestId('confirm-delete-btn');
    expect(deleteBtn.className).toContain('var(--color-error)');
  });
});
