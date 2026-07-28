import { motion } from 'framer-motion';
import Button from './Button';

interface Props { message: string; onRetry?: () => void; }

export default function ErrorDisplay({ message, onRetry }: Props) {
  return (
    <motion.div
      className="flex items-center justify-center py-12"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <div
        className="text-center rounded-xl px-8 py-10"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div className="text-4xl mb-4">😕</div>
        <p
          className="mb-4"
          style={{
            color: 'var(--color-text-secondary)',
            fontSize: 'var(--text-base)',
          }}
        >
          {message}
        </p>
        {onRetry && (
          <Button onClick={onRetry} variant="ghost">重试</Button>
        )}
      </div>
    </motion.div>
  );
}