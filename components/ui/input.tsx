import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, onWheel, ...props }, ref) => {
  function handleWheel(e: React.WheelEvent<HTMLInputElement>) {
    // Prevent accidental value changes when scrolling past a focused number input.
    if (type === "number") e.currentTarget.blur();
    onWheel?.(e);
  }
  return (
    <input
      ref={ref}
      type={type}
      onWheel={handleWheel}
      className={cn(
        "block w-full h-9 px-3 rounded-md bg-surface border border-border text-sm text-text placeholder:text-text-subtle",
        "focus:outline-none focus:ring-2 focus:ring-brand-700/30 focus:border-brand-700",
        "disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = "Input";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "block w-full h-9 px-2 rounded-md bg-surface border border-border text-sm text-text",
      "focus:outline-none focus:ring-2 focus:ring-brand-700/30 focus:border-brand-700",
      "disabled:opacity-60",
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "block w-full px-3 py-2 rounded-md bg-surface border border-border text-sm text-text placeholder:text-text-subtle",
      "focus:outline-none focus:ring-2 focus:ring-brand-700/30 focus:border-brand-700",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export function Label({
  children,
  htmlFor,
  className,
}: {
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-xs font-medium text-text-muted", className)}
    >
      {children}
    </label>
  );
}
