import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-brand-700 text-white hover:bg-brand-800 shadow-sm focus-visible:ring-brand-700/40",
  secondary:
    "bg-surface text-text border border-border hover:bg-surface-2 focus-visible:ring-brand-700/30",
  ghost:
    "text-text-muted hover:bg-surface-2 hover:text-text focus-visible:ring-brand-700/30",
  destructive:
    "bg-red-600 text-white hover:bg-red-700 shadow-sm focus-visible:ring-red-600/40",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-2.5 text-xs gap-1",
  md: "h-9 px-3 text-sm gap-1.5",
  lg: "h-10 px-4 text-sm gap-2",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Render as the single child instead of a <button>. Used to wrap <Link>
   *  with button styling without nesting a button inside an anchor. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", asChild = false, children, ...props }, ref) => {
    const classes = cn(
      "inline-flex items-center justify-center rounded-md font-medium tracking-tight transition-colors disabled:opacity-60 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-page",
      VARIANT[variant],
      SIZE[size],
      className,
    );
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{ className?: string }>;
      return React.cloneElement(child, {
        className: cn(classes, child.props.className),
        ...(props as Record<string, unknown>),
      });
    }
    return (
      <button ref={ref} className={classes} {...props}>
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
