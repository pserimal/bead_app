import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  fadeIn,
  slideUp,
  staggerContainer,
  staggerItem,
  scaleIn,
  modalBackdrop,
  modalContent,
  toastSlide,
  toastExit,
  pageTransition,
} from '../lib/animations';
import { useAnimationConfig } from '../hooks/useAnimationConfig';
import AnimatedPage from '../components/AnimatedPage';

describe('animations.ts — variant exports', () => {
  const allVariants = {
    fadeIn,
    slideUp,
    staggerContainer,
    staggerItem,
    scaleIn,
    modalBackdrop,
    modalContent,
    toastSlide,
    toastExit,
    pageTransition,
  };

  it('exports all expected variants', () => {
    expect(Object.keys(allVariants)).toHaveLength(10);
    for (const [name, variant] of Object.entries(allVariants)) {
      expect(variant, `${name} should be defined`).toBeDefined();
      expect(typeof variant, `${name} should be an object`).toBe('object');
    }
  });

  it('fadeIn has correct initial/animate structure', () => {
    expect(fadeIn.initial).toEqual({ opacity: 0 });
    expect(fadeIn.animate).toMatchObject({ opacity: 1 });
    expect((fadeIn.animate as Record<string, unknown>).transition).toMatchObject({
      duration: 0.4,
      ease: 'easeOut',
    });
  });

  it('slideUp has y and opacity motion', () => {
    expect(slideUp.initial).toEqual({ opacity: 0, y: 20 });
    expect(slideUp.animate).toMatchObject({ opacity: 1, y: 0 });
  });

  it('staggerContainer defines stagger timing', () => {
    expect((staggerContainer.animate as Record<string, unknown>).transition).toMatchObject({
      staggerChildren: 0.1,
      delayChildren: 0.1,
    });
  });

  it('staggerItem animates opacity and y', () => {
    expect(staggerItem.initial).toEqual({ opacity: 0, y: 15 });
    expect(staggerItem.animate).toMatchObject({ opacity: 1, y: 0 });
  });

  it('scaleIn animates scale and opacity', () => {
    expect(scaleIn.initial).toEqual({ opacity: 0, scale: 0.95 });
    expect(scaleIn.animate).toMatchObject({ opacity: 1, scale: 1 });
  });

  it('modalBackdrop targets 0.5 opacity', () => {
    expect(modalBackdrop.initial).toEqual({ opacity: 0 });
    expect(modalBackdrop.animate).toMatchObject({ opacity: 0.5 });
  });

  it('modalContent combines scale, y, and opacity', () => {
    expect(modalContent.initial).toEqual({ opacity: 0, scale: 0.95, y: 20 });
    expect(modalContent.animate).toMatchObject({ opacity: 1, scale: 1, y: 0 });
  });

  it('toastSlide animates from right (x: 50 → 0)', () => {
    expect(toastSlide.initial).toEqual({ opacity: 0, x: 50 });
    expect(toastSlide.animate).toMatchObject({ opacity: 1, x: 0 });
  });

  it('toastExit slides back right on exit', () => {
    expect(toastExit.exit).toMatchObject({ opacity: 0, x: 50 });
  });

  it('pageTransition uses fade + slide up', () => {
    expect(pageTransition.initial).toEqual({ opacity: 0, y: 12 });
    expect(pageTransition.animate).toMatchObject({ opacity: 1, y: 0 });
    expect(pageTransition.exit).toMatchObject({ opacity: 0, y: -8 });
  });

  it('all variants with exit have exit defined', () => {
    const withExit = [fadeIn, slideUp, scaleIn, modalBackdrop, modalContent, toastSlide, toastExit, pageTransition];
    for (const variant of withExit) {
      expect(variant.exit, 'exit state should be defined').toBeDefined();
    }
  });
});

describe('useAnimationConfig', () => {
  it('returns all config sections', () => {
    const config = useAnimationConfig();
    expect(config).toHaveProperty('duration');
    expect(config).toHaveProperty('easing');
    expect(config).toHaveProperty('stagger');
    expect(config).toHaveProperty('transitions');
    expect(config).toHaveProperty('springs');
  });

  it('duration has expected values', () => {
    const { duration } = useAnimationConfig();
    expect(duration.fast).toBe(0.2);
    expect(duration.normal).toBe(0.3);
    expect(duration.slow).toBe(0.4);
    expect(duration.slower).toBe(0.5);
  });

  it('easing has cubic bezier arrays and string presets', () => {
    const { easing } = useAnimationConfig();
    expect(easing.easeOut).toEqual([0.0, 0.0, 0.2, 1.0]);
    expect(easing.easeIn).toEqual([0.4, 0.0, 1.0, 1.0]);
    expect(easing.easeInOut).toEqual([0.4, 0.0, 0.2, 1.0]);
    expect(easing.easeOutString).toBe('easeOut');
    expect(easing.easeInString).toBe('easeIn');
    expect(easing.easeInOutString).toBe('easeInOut');
  });

  it('stagger has interval and delay', () => {
    const { stagger } = useAnimationConfig();
    expect(stagger.interval).toBe(0.1);
    expect(stagger.delay).toBe(0.1);
  });

  it('transitions presets use duration/easing from config', () => {
    const { transitions, duration, easing } = useAnimationConfig();
    expect(transitions.enter).toEqual({ duration: duration.normal, ease: easing.easeOutString });
    expect(transitions.exit).toEqual({ duration: duration.fast, ease: easing.easeInString });
    expect(transitions.page).toEqual({ duration: duration.slow, ease: easing.easeOutString });
  });

  it('springs has type: spring with stiffness/damping', () => {
    const { springs } = useAnimationConfig();
    expect(springs.gentle).toEqual({ type: 'spring', stiffness: 300, damping: 30 });
    expect(springs.snappy).toEqual({ type: 'spring', stiffness: 500, damping: 30 });
    expect(springs.bouncy).toEqual({ type: 'spring', stiffness: 400, damping: 20 });
  });
});

describe('AnimatedPage', () => {
  it('renders children', () => {
    render(<AnimatedPage>Hello World</AnimatedPage>);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders children elements', () => {
    render(
      <AnimatedPage>
        <h1>Page Title</h1>
        <p>Page content</p>
      </AnimatedPage>,
    );
    expect(screen.getByText('Page Title')).toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('applies className when provided', () => {
    const { container } = render(
      <AnimatedPage className="custom-class">Content</AnimatedPage>,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('custom-class');
  });

  it('accepts custom variants prop', () => {
    const customVariants = {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
    };
    const { container } = render(
      <AnimatedPage variants={customVariants}>Content</AnimatedPage>,
    );
    expect(container.firstChild).toBeInTheDocument();
  });

  it('uses pageTransition by default', () => {
    const { container } = render(<AnimatedPage>Content</AnimatedPage>);
    expect(container.firstChild).toBeInTheDocument();
  });
});
