import { motion } from 'framer-motion';
import type { Variants } from 'framer-motion';
import type { ReactNode } from 'react';
import { pageTransition } from '../lib/animations';

interface AnimatedPageProps {
  children: ReactNode;
  variants?: Variants;
  className?: string;
}

export default function AnimatedPage({
  children,
  variants = pageTransition,
  className,
}: AnimatedPageProps) {
  return (
    <motion.div
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      className={className}
    >
      {children}
    </motion.div>
  );
}
