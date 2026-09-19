import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] text-[13.5px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 select-none',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm',
        secondary: 'bg-inset text-primary hover:bg-hover border border-subtle',
        ghost: 'text-secondary hover:bg-hover hover:text-primary',
        danger: 'bg-danger-soft text-danger hover:brightness-95',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-3.5',
        lg: 'h-10 px-4 text-sm',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, type = 'button', ...props }, ref) => (
    // Default to type="button": a bare <button> inside a <form> submits it, which closed the edit
    // dialog whenever the OAuth "authorise" button was clicked.
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export const IconButton = React.forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(({ label, className, ...props }, ref) => (
  <Button ref={ref} variant="ghost" size="icon" aria-label={label} title={label} className={cn('rounded-[var(--radius-sm)]', className)} {...props} />
));
IconButton.displayName = 'IconButton';
