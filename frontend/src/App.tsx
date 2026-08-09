import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence } from 'framer-motion';
import Layout from './components/Layout';
import AnimatedPage from './components/AnimatedPage';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastContext';
import { pageSlideUpFadeOut } from './lib/animations';
import UploadPage from './pages/UploadPage';
import CropPage from './pages/CropPage';
import HistoryPage from './pages/HistoryPage';
import JobDetailPage from './pages/JobDetailPage';
import BlueprintDetailPage from './pages/BlueprintDetailPage';
import CorrectionPage from './pages/CorrectionPage';
import ColorLibraryPage from './pages/ColorLibraryPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AnimatedRoutes() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.key}>
        <Route
          path="/"
          element={
            <AnimatedPage variants={pageSlideUpFadeOut}>
              <UploadPage />
            </AnimatedPage>
          }
        />
        <Route
          path="/crop"
          element={
            <AnimatedPage variants={pageSlideUpFadeOut}>
              <CropPage />
            </AnimatedPage>
          }
        />
        <Route
          path="/blueprints"
          element={
            <AnimatedPage variants={pageSlideUpFadeOut}>
              <HistoryPage />
            </AnimatedPage>
          }
        />
        <Route
          path="/jobs/:id"
          element={
            <AnimatedPage variants={pageSlideUpFadeOut}>
              <JobDetailPage />
            </AnimatedPage>
          }
        />
        <Route
          path="/blueprints/:id"
          element={
            <AnimatedPage variants={pageSlideUpFadeOut}>
              <BlueprintDetailPage />
            </AnimatedPage>
          }
        />
        <Route
          path="/blueprints/:id/correct"
          element={
            <AnimatedPage variants={pageSlideUpFadeOut}>
              <CorrectionPage />
            </AnimatedPage>
          }
        />
        <Route
          path="/colors"
          element={
            <AnimatedPage variants={pageSlideUpFadeOut}>
              <ColorLibraryPage />
            </AnimatedPage>
          }
        />
      </Routes>
    </AnimatePresence>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <ToastProvider>
          <BrowserRouter>
            <Layout>
              <AnimatedRoutes />
            </Layout>
          </BrowserRouter>
        </ToastProvider>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
