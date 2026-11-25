import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";

/** The model the picker shows while nothing is chosen, so create sends what the user saw. */
export function useBotDefaultModel(environmentId: EnvironmentId): ModelSelection | null {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  return scheduledTaskDefaultModel(
    settings,
    null,
    providerInstanceEntriesFor(providers, settings, null),
  );
}

/** The new-thread model picker; null means the environment's default model. */
export function BotModelPicker({
  environmentId,
  value,
  disabled = false,
  onChange,
}: {
  environmentId: EnvironmentId;
  value: ModelSelection | null;
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const shown =
    value !== null &&
    instanceEntries.some((entry) => entry.instanceId === value.instanceId && entry.enabled)
      ? value
      : scheduledTaskDefaultModel(settings, null, instanceEntries);
  const instanceId =
    shown?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const model = shown?.model ?? "";
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      disabled={disabled}
      activeInstanceId={instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={getCustomModelOptionsByInstance(
        settings,
        providers,
        instanceId,
        model,
      )}
      isComposerOwned={false}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      onInstanceModelChange={(nextInstanceId, nextModel) => {
        if (nextInstanceId === instanceId && nextModel === model) return;
        onChange(createModelSelection(nextInstanceId, nextModel));
      }}
    />
  );
}
