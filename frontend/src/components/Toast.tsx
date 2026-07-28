import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { toastSlide } from '../lib/animations';

type ToastType = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  type?: ToastType;
  onClose: () => void;
  duration?: number;
}

const typeStyles: Record<ToastType, { bg: string; icon: string }> = {
  success: {
    bg: 'bg-[var(--color-success)]',
    icon: '✓',
  },
  error: {
    bg: 'bg-[var(--color-error)]',
    icon: '✕',
  },
  info: {
    bg: 'bg-[var(--color-accent)]',
    icon: 'ℹ',
  },
};

export default function Toast({
  message,
  type = 'info',
  onClose,
  duration = 3000,
}: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const style = typeStyles[type];

  return (
    <motion.div
      variants={toastSlide}
      initial="initial"
      animate="animate"
      exit="exit"
      className={`${style.bg} text-[var(--color-text-inverse)] rounded-[var(--radius-lg)] px-4 py-3 shadow-[var(--shadow-lg)] flex items-center gap-2 text-sm font-medium min-w-[280px]`}
      data-testid="toast"
    >
      <span className="text-base">{style.icon}</span>
      <span className="flex-1">{message}</span>
      <button
        onClick={onClose}
        className="ml-2 opacity-70 hover:opacity-100 transition-opacity duration-[var(--transition-fast)]"
        aria-label="关闭"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </motion.div>
  );
}
