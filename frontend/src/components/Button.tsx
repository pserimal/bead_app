import type { ReactNode, MouseEventHandler } from 'react';
import { motion } from 'framer-motion';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

type ButtonSize = 'md' | 'sm' | 'xs';

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
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
  size = 'md',
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
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${size === 'sm' ? 'px-2.5 py-1.5 text-xs' : size === 'xs' ? 'px-2 py-1 text-xs' : 'px-4 py-2 text-sm'} ${variantBgStyles[variant]} ${variantStyles[variant]} ${className}`}
      disabled={disabled}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

/**
 * 紧凑工具钮（缩放 −/+/100%/适应窗口 这类）的共享样式工厂。
 * 统一各页面工具钮外观：minWidth 34 / height 32 / 等宽字体，卡片底 + 描边 + md 圆角。
 */
// eslint-disable-next-line react-refresh/only-export-components
export function toolButtonStyle(): React.CSSProperties {
  return {
    minWidth: 34,
    height: 32,
    padding: '0 9px',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    background: 'var(--color-card)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  };
}
