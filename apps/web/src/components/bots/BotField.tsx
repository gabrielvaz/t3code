import type { ReactNode } from "react";

import { Label } from "../ui/label";

export function BotField({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string | undefined;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}
