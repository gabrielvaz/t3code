import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { useManagedPolicy } from "../../state/managedPolicy";
import { resolveRuntimeModeOptions, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function BotRuntimeModeSelect({
  id,
  environmentId,
  value,
  disabled = false,
  onChange,
}: {
  id?: string;
  environmentId: EnvironmentId;
  value: RuntimeMode;
  disabled?: boolean;
  onChange: (mode: RuntimeMode) => void;
}) {
  const messages = useMessages();
  const options = resolveRuntimeModeOptions(
    runtimeModeOptions,
    useManagedPolicy(environmentId),
    messages,
  );
  const selected = options.find((option) => option.mode === value);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(mode) => {
        const option = options.find((candidate) => candidate.mode === mode);
        if (option && option.disabledReason === undefined) onChange(option.mode);
      }}
    >
      <SelectTrigger id={id} size="sm">
        <SelectValue>
          {selected ? (
            <span className="flex items-center gap-2">
              <selected.icon className="size-4 opacity-70" />
              {selected.label}
            </span>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem
            key={option.mode}
            value={option.mode}
            label={option.label}
            disabled={option.disabledReason !== undefined}
          >
            <span className="flex min-w-0 items-start gap-2">
              <option.icon className="mt-0.5 size-4 shrink-0 opacity-70" />
              <span className="min-w-0">
                <span className="block">{option.label}</span>
                <span className="block max-w-72 text-xs text-muted-foreground">
                  {option.disabledReason ?? option.description}
                </span>
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
