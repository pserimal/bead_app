export const duration = {
  fast: 0.2,
  normal: 0.3,
  slow: 0.4,
  slower: 0.5,
} as const;

export const easing = {
  easeOut: [0.0, 0.0, 0.2, 1.0] as [number, number, number, number],
  easeIn: [0.4, 0.0, 1.0, 1.0] as [number, number, number, number],
  easeInOut: [0.4, 0.0, 0.2, 1.0] as [number, number, number, number],
  easeOutString: 'easeOut' as const,
  easeInString: 'easeIn' as const,
  easeInOutString: 'easeInOut' as const,
} as const;

export const stagger = {
  interval: 0.1,
  delay: 0.1,
} as const;

export const transitions = {
  enter: {
    duration: duration.normal,
    ease: easing.easeOutString,
  },
  exit: {
    duration: duration.fast,
    ease: easing.easeInString,
  },
  page: {
    duration: duration.slow,
    ease: easing.easeOutString,
  },
  stagger: {
    staggerChildren: stagger.interval,
    delayChildren: stagger.delay,
  },
} as const;

export const springs = {
  gentle: { type: 'spring' as const, stiffness: 300, damping: 30 },
  snappy: { type: 'spring' as const, stiffness: 500, damping: 30 },
  bouncy: { type: 'spring' as const, stiffness: 400, damping: 20 },
} as const;

export function useAnimationConfig() {
  return {
    duration,
    easing,
    stagger,
    transitions,
    springs,
  } as const;
}
