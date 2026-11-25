import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BOT_NAME_MAX_CHARS, BOT_ROLE_MAX_CHARS } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { MessageSquareIcon, Trash2Icon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import type { EnvironmentBot } from "../../state/bots";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { BotAvatarPicker } from "./BotAvatarPicker";
import { BotModelPicker } from "./BotModelPicker";
import { BotRuntimeModeSelect } from "./BotRuntimeModeSelect";
import { useBotActions } from "./useBotActions";

/** A text field that saves when it loses focus or on Enter, and reverts on Escape. */
function BotTextSetting({
  label,
  value,
  maxLength,
  required,
  disabled,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  maxLength: number;
  required: boolean;
  disabled: boolean;
  placeholder?: string;
  onCommit: (value: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next === value || (required && next.length === 0)) return setDraft(null);
    void onCommit(next).then((saved) => saved && setDraft(null));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") setDraft(null);
  };
  return (
    <Input
      aria-label={label}
      value={draft ?? value}
      maxLength={maxLength}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
    />
  );
}

export function BotDetailsTab({ entry }: { entry: EnvironmentBot }) {
  const gt = useGT();
  const { bot, environmentId } = entry;
  const canOperate = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const canDelete = useAtomValue(serverEnvironment.deleteBot.permissionAtom(environmentId));
  const { update, confirmAndDelete } = useBotActions();
  const navigate = useNavigate();
  return (
    <div className="space-y-8">
      <SettingsSection title={gt("Profile")}>
        <SettingsRow
          title={gt("Name")}
          control={
            <BotTextSetting
              label={gt("Name")}
              value={bot.name}
              maxLength={BOT_NAME_MAX_CHARS}
              required
              disabled={!canOperate}
              onCommit={(name) => update(entry, { name })}
            />
          }
        />
        <SettingsRow
          title={gt("What it is for")}
          description={gt("One line, shown under its name.")}
          control={
            <BotTextSetting
              label={gt("What it is for")}
              value={bot.role}
              maxLength={BOT_ROLE_MAX_CHARS}
              required={false}
              disabled={!canOperate}
              placeholder={gt("e.g. Keeps an eye on my inbox and calendar")}
              onCommit={(role) => update(entry, { role })}
            />
          }
        />
        <SettingsRow
          title={gt("Pinned")}
          description={gt("Pinned Bots stay at the top of the Bots section.")}
          control={
            <Switch
              checked={bot.pinned}
              disabled={!canOperate}
              aria-label={gt("Pin {name}", { name: bot.name })}
              onCheckedChange={(pinned) => void update(entry, { pinned })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={gt("Avatar")}>
        <div className="p-4">
          <BotAvatarPicker
            value={bot.avatar}
            name={bot.name}
            disabled={!canOperate}
            onChange={(avatar) => void update(entry, { avatar })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={gt("Agent")}>
        <SettingsRow
          title={gt("Model")}
          description={gt("Used when the Bot's thread starts a new session.")}
          control={
            <BotModelPicker
              environmentId={environmentId}
              value={bot.model}
              disabled={!canOperate}
              onChange={(model) => void update(entry, { model })}
            />
          }
        />
        <SettingsRow
          title={gt("Permissions")}
          description={gt("What the Bot may do without asking you first.")}
          control={
            <BotRuntimeModeSelect
              environmentId={environmentId}
              value={bot.runtimeMode}
              disabled={!canOperate}
              onChange={(runtimeMode) => void update(entry, { runtimeMode })}
            />
          }
        />
        <SettingsRow
          title={gt("Chat")}
          description={gt("The Bot's long-lived thread.")}
          control={
            bot.threadId === null ? (
              <span className="text-sm text-muted-foreground">
                <T>Being set up…</T>
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(scopeThreadRef(environmentId, bot.threadId))}
                  />
                }
              >
                <MessageSquareIcon />
                <T>Open chat</T>
              </Button>
            )
          }
        />
      </SettingsSection>

      <SettingsSection title={gt("Delete")}>
        <SettingsRow
          title={gt("Delete this Bot")}
          description={gt(
            "Deletes its thread and moves its folder, with its memory and instructions, to the Bots trash on the server.",
          )}
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!canDelete}
              onClick={() =>
                void confirmAndDelete(entry).then((deleted) => {
                  if (deleted) void navigate({ to: "/" });
                })
              }
            >
              <Trash2Icon />
              <T>Delete Bot</T>
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}
