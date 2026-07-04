import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { surface } from '../design';

interface ControlButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: 'neutral' | 'primary' | 'danger';
  children: ReactNode;
}

const toneClass: Record<NonNullable<ControlButtonProps['tone']>, string> = {
  neutral: 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/8',
  primary: 'border-cyan-300/20 bg-cyan-300/12 text-cyan-100 hover:bg-cyan-300/18',
  danger: 'border-rose-300/20 bg-rose-300/10 text-rose-100 hover:bg-rose-300/16',
};

export function ControlButton({ tone = 'neutral', className = '', children, ...props }: ControlButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/5 disabled:text-zinc-700 ${toneClass[tone]} ${surface.focus} ${className}`}
    >
      {children}
    </button>
  );
}
