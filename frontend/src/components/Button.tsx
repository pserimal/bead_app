import type { ReactNode, MouseEventHandler } from 'react';
import { motion } from 'framer-motion';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps {
  variant?: ButtonVariant;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  type?: 'button' | 'submit' | 'reset';
  title?: string;
  'data-testid'?: string;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] focus-visible:ring-[var(--color-accent)]',
  secondary:
    'text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] focus-visible:ring-[var(--color-border-strong)]',
  ghost:
    'bg-transparent text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] focus-visible:ring-[var(--color-border-strong)]',
  danger:
    'text-[var(--color-text-inverse)] hover:opacity-90 focus-visible:ring-[var(--color-error)]',
};

const variantBgStyles: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--color-accent)]',
  secondary: 'bg-[var(--color-bg-secondary)]',
  ghost: 'bg-transparent',
  danger: 'bg-[var(--color-error)]',
};

export default function Button({
  variant = 'primary',
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <motion.button
      whileHover={disabled ? undefined : { scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${variantBgStyles[variant]} ${variantStyles[variant]} ${className}`}
      disabled={disabled}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
