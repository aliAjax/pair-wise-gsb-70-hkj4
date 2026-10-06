import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '../../lib/utils';

export function Progress({
  className,
  value = 0,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const safeValue = typeof value === 'number' ? value : 0;
  return (
    <ProgressPrimitive.Root
      className={cn('relative h-2 overflow-hidden rounded-sm bg-slate-200', className)}
      value={safeValue}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full bg-sky-700 transition-transform"
        style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, safeValue))}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
