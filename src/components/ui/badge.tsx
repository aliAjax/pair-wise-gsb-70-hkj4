import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

type BadgeTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'slate';

const tones: Record<BadgeTone, string> = {
  neutral: 'border-slate-300 bg-slate-100 text-slate-700',
  blue: 'border-sky-300 bg-sky-50 text-sky-800',
  green: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  amber: 'border-amber-300 bg-amber-50 text-amber-800',
  red: 'border-red-300 bg-red-50 text-red-800',
  slate: 'border-slate-400 bg-slate-700 text-white',
};

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium leading-5',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
