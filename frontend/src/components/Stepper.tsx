interface Step {
  id: string;
  label: string;
  optional?: boolean;
}

interface StepperProps {
  steps: Step[];
  current: number; // 0-based index of current step
  completed: boolean[]; // per-step completed flag
  onStepClick?: (index: number) => void;
}

export default function Stepper({ steps, current, completed, onStepClick }: StepperProps) {
  return (
    <div className="flex items-center gap-2 py-3">
      {steps.map((step, idx) => {
        const isCompleted = completed[idx];
        const isCurrent = idx === current;
        const isClickable = isCompleted || idx < current;
        return (
          <div key={step.id} className="flex items-center gap-2 flex-1">
            <button
              type="button"
              disabled={!isClickable || !onStepClick}
              onClick={() => isClickable && onStepClick?.(idx)}
              className="flex items-center gap-2 flex-1 text-left disabled:cursor-default"
            >
              <span
                className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors"
                style={{
                  background: isCompleted
                    ? 'var(--color-success)'
                    : isCurrent
                      ? 'var(--color-accent)'
                      : 'var(--color-border)',
                  color: isCompleted || isCurrent ? '#fff' : 'var(--color-text-muted)',
                }}
              >
                {isCompleted ? '✓' : idx + 1}
              </span>
              <span
                className="text-sm hidden sm:inline"
                style={{
                  fontWeight: isCurrent ? 700 : 500,
                  color: isCurrent ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                {step.label}
                {step.optional && (
                  <span className="ml-1 text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                    (可选)
                  </span>
                )}
              </span>
            </button>
            {idx < steps.length - 1 && (
              <span
                className="flex-1 h-px mx-1 hidden sm:block"
                style={{
                  background: isCompleted || completed[idx + 1] ? 'var(--color-success)' : 'var(--color-border)',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
