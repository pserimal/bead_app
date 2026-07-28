import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import Modal from '../components/Modal';
import Toast from '../components/Toast';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Modal — Framer Motion animations', () => {
  it('renders with motion.div and data-testid attributes', () => {
    render(
      <Modal title="Test Modal" onClose={vi.fn()}>
        <p>Modal content</p>
      </Modal>
    );

    expect(screen.getByTestId('modal-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
    expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Modal content')).toBeInTheDocument();
  });

  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Escape Test" onClose={onClose}>
        <p>Content</p>
      </Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on overlay click', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Overlay Test" onClose={onClose}>
        <p>Content</p>
      </Modal>
    );

    const overlay = screen.getByTestId('modal-overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside content', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Content Click" onClose={onClose}>
        <p>Inner content</p>
      </Modal>
    );

    const content = screen.getByTestId('modal-content');
    fireEvent.click(content);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses warm design tokens for styling', () => {
    render(
      <Modal title="Style Test" onClose={vi.fn()}>
        <p>Content</p>
      </Modal>
    );

    const content = screen.getByTestId('modal-content');
    const backdrop = screen.getByTestId('modal-backdrop');

    expect(content.className).toContain('var(--color-surface)');
    expect(content.className).toContain('var(--color-border)');
    expect(content.className).toContain('var(--shadow-xl)');
    expect(backdrop.className).toContain('var(--color-text)');
  });

  it('close button triggers onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Close Button" onClose={onClose}>
        <p>Content</p>
      </Modal>
    );

    const closeButton = screen.getByLabelText('关闭');
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Toast — Framer Motion animations', () => {
  it('renders with motion.div and data-testid', () => {
    render(
      <Toast message="Test message" type="info" onClose={vi.fn()} />
    );

    expect(screen.getByTestId('toast')).toBeInTheDocument();
    expect(screen.getByText('Test message')).toBeInTheDocument();
  });

  it('auto-dismisses after default duration (3000ms)', () => {
    const onClose = vi.fn();
    render(
      <Toast message="Auto dismiss" onClose={onClose} />
    );

    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('auto-dismisses after custom duration', () => {
    const onClose = vi.fn();
    render(
      <Toast message="Custom duration" onClose={onClose} duration={5000} />
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('close button triggers onClose immediately', () => {
    const onClose = vi.fn();
    render(
      <Toast message="Close test" onClose={onClose} />
    );

    const closeButton = screen.getByLabelText('关闭');
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalled();
  });

  it('success type uses warm green color', () => {
    render(
      <Toast message="Success" type="success" onClose={vi.fn()} />
    );

    const toast = screen.getByTestId('toast');
    expect(toast.className).toContain('var(--color-success)');
    expect(toast.className).toContain('var(--color-text-inverse)');
  });

  it('error type uses warm red color', () => {
    render(
      <Toast message="Error" type="error" onClose={vi.fn()} />
    );

    const toast = screen.getByTestId('toast');
    expect(toast.className).toContain('var(--color-error)');
  });

  it('info type uses accent color', () => {
    render(
      <Toast message="Info" type="info" onClose={vi.fn()} />
    );

    const toast = screen.getByTestId('toast');
    expect(toast.className).toContain('var(--color-accent)');
  });

  it('uses warm design tokens for borders and shadows', () => {
    render(
      <Toast message="Style test" onClose={vi.fn()} />
    );

    const toast = screen.getByTestId('toast');
    expect(toast.className).toContain('var(--radius-lg)');
    expect(toast.className).toContain('var(--shadow-lg)');
  });
});
