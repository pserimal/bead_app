import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { modalBackdrop, modalContent } from '../lib/animations';

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
}

export default function Modal({ title, children, onClose }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        ref={overlayRef}
        className="fixed inset-0 z-50 flex items-center justify-center"
        onClick={handleOverlayClick}
        data-testid="modal-overlay"
      >
        <motion.div
          className="absolute inset-0 bg-[var(--color-text)]"
          variants={modalBackdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          data-testid="modal-backdrop"
        />

        <motion.div
          className="relative bg-[var(--color-surface)] rounded-[var(--radius-xl)] shadow-[var(--shadow-xl)] max-w-lg w-full mx-4 max-h-[85vh] flex flex-col border border-[var(--color-border)]"
          variants={modalContent}
          initial="initial"
          animate="animate"
          exit="exit"
          data-testid="modal-content"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
            <h2 className="text-[var(--text-lg)] font-semibold text-[var(--color-text)] font-[var(--font-display)]">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors duration-[var(--transition-fast)]"
              aria-label="关闭"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="px-6 py-4 overflow-y-auto flex-1">
            {children}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
