import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import SkeletonCard from '../components/SkeletonCard';

describe('Button — warm themed variants', () => {
  it('renders primary variant', () => {
    render(<Button variant="primary">Primary</Button>);
    const btn = screen.getByRole('button', { name: 'Primary' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('var(--color-accent)');
    expect(btn.className).toContain('var(--color-text-inverse)');
  });

  it('renders secondary variant', () => {
    render(<Button variant="secondary">Secondary</Button>);
    const btn = screen.getByRole('button', { name: 'Secondary' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('var(--color-bg-secondary)');
    expect(btn.className).toContain('var(--color-text)');
  });

  it('renders ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole('button', { name: 'Ghost' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('bg-transparent');
    expect(btn.className).toContain('var(--color-text)');
  });

  it('renders danger variant', () => {
    render(<Button variant="danger">Danger</Button>);
    const btn = screen.getByRole('button', { name: 'Danger' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('var(--color-error)');
    expect(btn.className).toContain('var(--color-text-inverse)');
  });

  it('defaults to primary variant', () => {
    render(<Button>Default</Button>);
    const btn = screen.getByRole('button', { name: 'Default' });
    expect(btn.className).toContain('var(--color-accent)');
  });

  it('applies disabled state', () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole('button', { name: 'Disabled' });
    expect(btn).toBeDisabled();
    expect(btn.className).toContain('disabled:opacity-50');
  });

  it('merges custom className', () => {
    render(<Button className="extra-class">Custom</Button>);
    const btn = screen.getByRole('button', { name: 'Custom' });
    expect(btn.className).toContain('extra-class');
  });

  it('does not use indigo or slate Tailwind classes', () => {
    render(<Button variant="primary">Check</Button>);
    const btn = screen.getByRole('button', { name: 'Check' });
    expect(btn.className).not.toContain('indigo');
    expect(btn.className).not.toContain('slate');
  });
});

describe('Spinner — warm themed', () => {
  it('renders with default md size', () => {
    render(<Spinner />);
    const spinner = screen.getByRole('status');
    expect(spinner).toBeInTheDocument();
    expect(spinner.getAttribute('class')).toContain('w-6 h-6');
  });

  it('renders sm size', () => {
    render(<Spinner size="sm" />);
    const spinner = screen.getByRole('status');
    expect(spinner.getAttribute('class')).toContain('w-4 h-4');
  });

  it('renders lg size', () => {
    render(<Spinner size="lg" />);
    const spinner = screen.getByRole('status');
    expect(spinner.getAttribute('class')).toContain('w-8 h-8');
  });

  it('uses warm accent color via CSS variable', () => {
    render(<Spinner />);
    const spinner = screen.getByRole('status');
    expect(spinner.style.color).toBe('var(--color-accent)');
  });

  it('does not use indigo classes', () => {
    render(<Spinner />);
    const spinner = screen.getByRole('status');
    expect(spinner.getAttribute('class')).not.toContain('indigo');
  });

  it('has animate-spin class', () => {
    render(<Spinner />);
    const spinner = screen.getByRole('status');
    expect(spinner.getAttribute('class')).toContain('animate-spin');
  });

  it('applies custom className', () => {
    render(<Spinner className="my-extra" />);
    const spinner = screen.getByRole('status');
    expect(spinner.getAttribute('class')).toContain('my-extra');
  });
});

describe('SkeletonCard — warm themed with shimmer', () => {
  it('renders the skeleton card', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.firstElementChild as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(card.className).toContain('rounded-xl');
    expect(card.className).toContain('overflow-hidden');
  });

  it('applies warm CSS variable colors', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.background).toBe('var(--color-surface)');
    expect(card.style.border).toBe('1px solid var(--color-border)');
  });

  it('contains shimmer animation class', () => {
    const { container } = render(<SkeletonCard />);
    const shimmerElements = container.querySelectorAll('.skeleton-shimmer');
    expect(shimmerElements.length).toBeGreaterThanOrEqual(3);
  });

  it('does not use slate classes', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).not.toContain('slate');
    expect(card.innerHTML).not.toContain('slate');
  });

  it('has the correct card structure', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.children).toHaveLength(2);
    expect(card.children[0]).toHaveClass('h-32');
    expect(card.children[1]).toHaveClass('p-3');
  });
});
