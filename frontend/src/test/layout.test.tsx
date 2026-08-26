import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Layout from '../components/Layout';

function renderLayout(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Layout>
        <div>Test Content</div>
      </Layout>
    </MemoryRouter>,
  );
}

describe('Layout — navigation rendering', () => {
  it('renders all nav items in desktop nav', () => {
    renderLayout();
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByText('上传图纸')).toBeInTheDocument();
    expect(within(nav).getByText('任务历史')).toBeInTheDocument();
    expect(within(nav).getByText('颜色库')).toBeInTheDocument();
    expect(within(nav).queryByText('物料清单录入')).not.toBeInTheDocument();
  });

  it('renders the app title', () => {
    renderLayout();
    expect(screen.getByText('拼豆助手')).toBeInTheDocument();
  });

  it('renders children content', () => {
    renderLayout();
    expect(screen.getByText('Test Content')).toBeInTheDocument();
  });

  it('title links to home', () => {
    renderLayout();
    const titleLink = screen.getByText('拼豆助手').closest('a');
    expect(titleLink).toHaveAttribute('href', '/');
  });

  it('nav item links have correct hrefs', () => {
    renderLayout();
    expect(screen.getByText('上传图纸').closest('a')).toHaveAttribute('href', '/');
    expect(screen.getByText('任务历史').closest('a')).toHaveAttribute('href', '/blueprints');
    expect(screen.getByText('颜色库').closest('a')).toHaveAttribute('href', '/colors');
  });

  it('applies warm surface color via CSS variable on nav', () => {
    renderLayout();
    const nav = screen.getByRole('navigation');
    expect(nav.style.background).toBe('var(--color-surface)');
  });

  it('applies display font on title', () => {
    renderLayout();
    const title = screen.getByText('拼豆助手');
    expect(title.style.fontFamily).toBe('var(--font-display)');
  });

  it('applies accent color on active nav item', () => {
    renderLayout('/');
    const activeLink = screen.getByText('上传图纸');
    expect(activeLink.style.color).toBe('var(--color-accent)');
  });
});

describe('Layout — mobile menu', () => {
  it('renders mobile toggle button', () => {
    renderLayout();
    const toggle = screen.getByRole('button', { name: /菜单/i });
    expect(toggle).toBeInTheDocument();
  });

  it('mobile menu is hidden by default', () => {
    renderLayout();
    expect(screen.queryByText('上传图纸', { selector: '.lg\\:hidden a' })).not.toBeInTheDocument();
  });

  it('opens mobile menu on toggle click', async () => {
    const user = userEvent.setup();
    renderLayout();
    const toggle = screen.getByRole('button', { name: /打开菜单/i });
    await user.click(toggle);

    expect(screen.getByRole('button', { name: /关闭菜单/i })).toBeInTheDocument();
  });

  it('closes mobile menu on second toggle click', async () => {
    const user = userEvent.setup();
    renderLayout();
    const toggle = screen.getByRole('button', { name: /打开菜单/i });
    await user.click(toggle);

    const closeToggle = screen.getByRole('button', { name: /关闭菜单/i });
    await user.click(closeToggle);

    expect(screen.getByRole('button', { name: /打开菜单/i })).toBeInTheDocument();
  });
});

describe('Layout — Framer Motion integration', () => {
  it('nav element is a motion.nav (rendered as nav)', () => {
    renderLayout();
    const nav = screen.getByRole('navigation');
    expect(nav.tagName).toBe('NAV');
  });

  it('desktop nav container has stagger variants applied', () => {
    renderLayout();
    const nav = screen.getByRole('navigation');
    const navItemsContainer = nav.querySelector('.hidden.lg\\:flex');
    expect(navItemsContainer).toBeInTheDocument();
  });
});

describe('Layout — warm theme consistency', () => {
  it('does not use indigo Tailwind classes', () => {
    const { container } = renderLayout();
    const html = container.innerHTML;
    expect(html).not.toContain('indigo');
  });

  it('does not use slate Tailwind classes', () => {
    const { container } = renderLayout();
    const html = container.innerHTML;
    expect(html).not.toMatch(/slate-\d/);
  });

  it('does not use bg-white class', () => {
    const { container } = renderLayout();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-white/);
  });

  it('uses CSS variables for color styling', () => {
    renderLayout();
    const nav = screen.getByRole('navigation');
    expect(nav.style.background).toContain('var(--color-');
  });
});
