import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UploadPage from '../pages/UploadPage';

function renderUploadPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UploadPage — renders correctly', () => {
  it('renders the page heading', () => {
    renderUploadPage();
    expect(screen.getByText('上传拼豆图纸')).toBeInTheDocument();
  });

  it('renders the file upload section heading', () => {
    renderUploadPage();
    expect(screen.getByText(/上传完整图纸/)).toBeInTheDocument();
  });

  it('renders the drag-and-drop prompt', () => {
    renderUploadPage();
    expect(screen.getByText('拖拽图纸到此处')).toBeInTheDocument();
    expect(screen.getByText(/或点击选择文件/)).toBeInTheDocument();
  });

  it('renders a hidden file input', () => {
    renderUploadPage();
    const input = document.getElementById('fileInput') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('file');
    expect(input.accept).toBe('image/jpeg,image/png');
  });

  it('does not render settings section before file upload', () => {
    renderUploadPage();
    expect(screen.queryByText('⚙️ 图纸设置')).not.toBeInTheDocument();
    expect(screen.queryByText('开始解析')).not.toBeInTheDocument();
  });
});

describe('UploadPage — warm theme compliance', () => {
  it('applies display font on page heading', () => {
    renderUploadPage();
    const heading = screen.getByText('上传拼豆图纸');
    expect(heading.style.fontFamily).toBe('var(--font-display)');
  });

  it('applies text color token on page heading', () => {
    renderUploadPage();
    const heading = screen.getByText('上传拼豆图纸');
    expect(heading.style.color).toBe('var(--color-text)');
  });

  it('drop zone uses border-strong token by default', () => {
    renderUploadPage();
    const dropZone = screen.getByText('拖拽图纸到此处').closest('div[class*="rounded-xl"]')!;
    expect(dropZone.style.border).toContain('var(--color-border-strong)');
  });

  it('drop zone uses surface token for background', () => {
    renderUploadPage();
    const dropZone = screen.getByText('拖拽图纸到此处').closest('div[class*="rounded-xl"]')!;
    expect(dropZone.style.background).toBe('var(--color-surface)');
  });

  it('does not use indigo or slate Tailwind classes', () => {
    renderUploadPage();
    const container = document.querySelector('[class*="max-w-3xl"]')!;
    expect(container.className).not.toMatch(/slate-\d/);
    expect(container.className).not.toMatch(/indigo-\d/);
  });
});

describe('UploadPage — stagger animation', () => {
  it('root container uses staggerContainer variants', () => {
    renderUploadPage();
    const container = document.querySelector('[class*="max-w-3xl"]')!;
    expect(container).toBeInTheDocument();
  });
});

describe('UploadPage — form interaction', () => {
  it('drop zone responds to click by opening file picker', async () => {
    renderUploadPage();
    const dropZone = screen.getByText('拖拽图纸到此处').closest('div[class*="rounded-xl"]')!;
    const input = document.getElementById('fileInput') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});
    await userEvent.click(dropZone);
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });
});
