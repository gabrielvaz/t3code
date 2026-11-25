import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_NAME_MAX_CHARS,
  BOT_ROLE_MAX_CHARS,
  type BotAvatar as BotAvatarValue,
  type EnvironmentId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState, type FormEvent } from "react";

import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { newBotDialogOpenAtom, useEnvironmentBots } from "../../state/bots";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotAvatar } from "./BotAvatar";
import { BotAvatarPicker, DEFAULT_BOT_AVATAR } from "./BotAvatarPicker";
import { BotField } from "./BotField";
import { BotModelPicker, useBotDefaultModel } from "./BotModelPicker";
import { BotRuntimeModeSelect } from "./BotRuntimeModeSelect";

/** Rendered once in the chat layout; `openNewBotDialog` opens it from anywhere. */
export function NewBotDialogHost() {
  const open = useAtomValue(newBotDialogOpenAtom);
  const close = () => appAtomRegistry.set(newBotDialogOpenAtom, false);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup className="max-w-xl">{open ? <NewBotForm onClose={close} /> : null}</DialogPopup>
    </Dialog>
  );
}

function NewBotForm({ onClose }: { onClose: () => void }) {
  const gt = useGT();
  const router = useRouter();
  const { environmentIds } = useEnvironmentBots();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    (chosenEnvironmentId !== null && environmentIds.includes(chosenEnvironmentId)
      ? chosenEnvironmentId
      : null) ??
    (primaryEnvironmentId !== null && environmentIds.includes(primaryEnvironmentId)
      ? primaryEnvironmentId
      : null) ??
    environmentIds[0] ??
    null;
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [avatar, setAvatar] = useState<BotAvatarValue>(DEFAULT_BOT_AVATAR);
  const [model, setModel] = useState<ModelSelection | null>(null);
  // No environment means submit is refused, so the placeholder id is never sent.
  const defaultModel = useBotDefaultModel(environmentId ?? ("" as EnvironmentId));
  const chosenModel = model ?? defaultModel;
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("auto");
  const [saving, setSaving] = useState(false);
  const canCreate = useAtomValue(serverEnvironment.createBot.permissionAtom(environmentId));
  const createBot = useAtomCommand(serverEnvironment.createBot, { label: "bot create" });
  const environmentLabel = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const trimmedName = name.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || environmentId === null || !canCreate || trimmedName.length === 0) return;
    setSaving(true);
    const result = await createBot({
      environmentId,
      input: {
        name: trimmedName,
        role: role.trim(),
        avatar,
        runtimeMode,
        ...(chosenModel === null ? {} : { model: chosenModel }),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not create the Bot"),
            description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
          }),
        );
      }
      return;
    }
    onClose();
    const threadId = result.value.bot.threadId;
    if (threadId !== null) {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    }
  };

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>
          <T>New Bot</T>
        </DialogTitle>
        <DialogDescription>
          <T>
            A Bot is a long-lived thread with a name, a face, standing instructions and a memory it
            keeps up to date.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          {environmentId === null ? (
            <p className="text-sm text-destructive" role="status">
              <T>Connect to an environment that supports Bots to create one.</T>
            </p>
          ) : null}
          <div className="flex items-start gap-4">
            <BotAvatar
              avatar={avatar}
              name={trimmedName || gt("Bot")}
              className="size-16 rounded-xl"
            />
            <div className="min-w-0 flex-1 space-y-3">
              <BotField label={gt("Name")} htmlFor="new-bot-name">
                <Input
                  id="new-bot-name"
                  autoFocus
                  required
                  maxLength={BOT_NAME_MAX_CHARS}
                  placeholder={gt("e.g. Scout")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </BotField>
              <BotField label={gt("What is it for?")} hint={gt("Optional")} htmlFor="new-bot-role">
                <Input
                  id="new-bot-role"
                  maxLength={BOT_ROLE_MAX_CHARS}
                  placeholder={gt("e.g. Keeps an eye on my inbox and calendar")}
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                />
              </BotField>
            </div>
          </div>
          <BotField label={gt("Avatar")}>
            <BotAvatarPicker
              value={avatar}
              name={trimmedName || gt("Bot")}
              disabled={saving}
              onChange={setAvatar}
            />
          </BotField>
          {environmentIds.length > 1 && environmentId !== null ? (
            <BotField label={gt("Runs on")} htmlFor="new-bot-environment">
              <Select
                value={environmentId}
                onValueChange={(id) => {
                  if (id === null) return;
                  setChosenEnvironmentId(id);
                  setModel(null);
                }}
              >
                <SelectTrigger id="new-bot-environment" size="sm">
                  <SelectValue>{environmentLabel(environmentId)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environmentIds.map((id) => (
                    <SelectItem key={id} value={id} label={environmentLabel(id)}>
                      {environmentLabel(id)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </BotField>
          ) : null}
          {environmentId !== null ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <BotField label={gt("Model")}>
                <div>
                  <BotModelPicker
                    environmentId={environmentId}
                    value={model}
                    disabled={saving}
                    onChange={setModel}
                  />
                </div>
              </BotField>
              <BotField label={gt("Permissions")} htmlFor="new-bot-runtime-mode">
                <BotRuntimeModeSelect
                  id="new-bot-runtime-mode"
                  environmentId={environmentId}
                  value={runtimeMode}
                  disabled={saving}
                  onChange={setRuntimeMode}
                />
              </BotField>
            </div>
          ) : null}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          <T>Cancel</T>
        </DialogClose>
        <Button
          type="submit"
          size="sm"
          disabled={saving || environmentId === null || !canCreate || trimmedName.length === 0}
        >
          <T>Create Bot</T>
        </Button>
      </DialogFooter>
    </form>
  );
}
