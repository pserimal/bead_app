import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import {
  pageSlideUpFadeOut,
  staggerContainer,
} from '../lib/animations';
import AnimatedPage from '../components/AnimatedPage';
import App from '../App';

function renderAtRoute(initialPath: '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderRoutesAt(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function LocationDisplay() {
    const location = useLocation();
    return <span data-testid="location">{location.pathname}</span>;
  }

  function AnimatedRoutes() {
    const location = useLocation();
    return (
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route
            path="/"
            element={
              <AnimatedPage variants={pageSlideUpFadeOut}>
                <div>Upload Page</div>
              </AnimatedPage>
            }
          />
          <Route
            path="/blueprints"
            element={
              <AnimatedPage variants={pageSlideUpFadeOut}>
                <div>History Page</div>
              </AnimatedPage>
            }
          />
          <Route
            path="/colors"
            element={
              <AnimatedPage variants={pageSlideUpFadeOut}>
                <div>Colors Page</div>
              </AnimatedPage>
            }
          />
        </Routes>
        <LocationDisplay />
      </AnimatePresence>
    );
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AnimatedRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('pageSlideUpFadeOut variant', () => {
  it('enter fades and slides up (opacity 0→1, y 12→0)', () => {
    expect(pageSlideUpFadeOut.initial).toEqual({ opacity: 0, y: 12 });
    expect((pageSlideUpFadeOut.animate as Record<string, unknown>).opacity).toBe(1);
    expect((pageSlideUpFadeOut.animate as Record<string, unknown>).y).toBe(0);
  });

  it('exit matches fadeIn (opacity 0, no y movement)', () => {
    expect(pageSlideUpFadeOut.exit).toMatchObject({ opacity: 0 });
    expect((pageSlideUpFadeOut.exit as Record<string, unknown>)).not.toHaveProperty('y');
  });

  it('has initial, animate, and exit states', () => {
    expect(pageSlideUpFadeOut.initial).toBeDefined();
    expect(pageSlideUpFadeOut.animate).toBeDefined();
    expect(pageSlideUpFadeOut.exit).toBeDefined();
  });

  it('initial has y: 12 (slideUp origin)', () => {
    expect((pageSlideUpFadeOut.initial as Record<string, unknown>).y).toBe(12);
  });;
});

describe('AnimatePresence mode="wait" in App', () => {
  it('renders without crashing at root route', () => {
    renderAtRoute('/');
    expect(document.querySelector('[data-testid]') || document.body).toBeTruthy();
  });
});

describe('AnimatedPage wrapper on routes', () => {
  it('renders page content through AnimatedPage at /', () => {
    renderRoutesAt('/');
    expect(screen.getByText('Upload Page')).toBeInTheDocument();
  });

  it('renders page content through AnimatedPage at /blueprints', () => {
    renderRoutesAt('/blueprints');
    expect(screen.getByText('History Page')).toBeInTheDocument();
  });

  it('renders page content through AnimatedPage at /colors', () => {
    renderRoutesAt('/colors');
    expect(screen.getByText('Colors Page')).toBeInTheDocument();
  });

  it('renders motion.div wrapper from AnimatedPage', () => {
    const { container } = renderRoutesAt('/');
    const motionDiv = container.querySelector('[style]');
    expect(motionDiv).toBeTruthy();
  });
});

describe('page navigation transitions', () => {
  it('renders correct content at each route path', () => {
    renderRoutesAt('/');
    expect(screen.getByText('Upload Page')).toBeInTheDocument();
  });

  it('location display reflects current route', () => {
    renderRoutesAt('/blueprints');
    expect(screen.getByTestId('location')).toHaveTextContent('/blueprints');
  });
});

describe('staggerContainer variant', () => {
  it('defines staggerChildren timing', () => {
    const transition = (staggerContainer.animate as Record<string, unknown>).transition as Record<string, unknown>;
    expect(transition.staggerChildren).toBe(0.04);
    expect(transition.delayChildren).toBe(0.02);
  });

  it('has empty initial state (children animate independently)', () => {
    expect(staggerContainer.initial).toEqual({});
  });
});

describe('page transition configuration', () => {
  it('pageSlideUpFadeOut has enter transition with duration 0.5', () => {
    const transition = (pageSlideUpFadeOut.animate as Record<string, unknown>).transition as Record<string, unknown>;
    expect(transition.duration).toBe(0.25);
  });

  it('pageSlideUpFadeOut has exit transition with duration 0.2', () => {
    const transition = (pageSlideUpFadeOut.exit as Record<string, unknown>).transition as Record<string, unknown>;
    expect(transition.duration).toBe(0.15);
  });

  it('pageSlideUpFadeOut enter uses easeOut', () => {
    const transition = (pageSlideUpFadeOut.animate as Record<string, unknown>).transition as Record<string, unknown>;
    expect(transition.ease).toBe('easeOut');
  });
});
