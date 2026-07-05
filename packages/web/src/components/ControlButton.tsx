import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { surface } from '../design';

interface ControlButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'neutral' | 'primary' | 'danger';
  children: ReactNode;
}

const toneClass: Record<NonNullable<ControlButtonProps['tone']>, string> = {
  neutral: 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50',
  primary: 'border-zinc-950 bg-zinc-950 text-white hover:bg-zinc-800',
  danger: 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100',
};

export function ControlButton({ tone = 'neutral', className = '', children, ...props }: ControlButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-400 ${toneClass[tone]} ${surface.focus} ${className}`}
    >
      {children}
    </button>
  );
}
