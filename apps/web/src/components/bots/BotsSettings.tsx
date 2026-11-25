import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type BotSaveSettingsInput,
  type BotsSharedSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { BotIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { openNewBotDialog, useEnvironmentBots } from "../../state/bots";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSearchableSetting } from "../settings/settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotAvatar } from "./BotAvatar";
import { BotConnectedAppsSettings } from "./BotConnectedAppsSettings";
import { BotSharedMemoryEditor } from "./BotPage";
import { BotVaultSettings } from "./BotVaultSettings";
import { parseBotRuleList, sortBotsForSidebar } from "./bots.logic";

function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isTimeZone(value: string): boolean {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: value });
    return formatter.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export function BotsSettings() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { environmentIds, settingsByEnvironment, bots } = useEnvironmentBots();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    [chosenEnvironmentId, primaryEnvironmentId].find(
      (id): id is EnvironmentId => id !== null && environmentIds.includes(id),
    ) ??
    environmentIds[0] ??
    null;
  const environmentLabel = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const settings = environmentId === null ? undefined : settingsByEnvironment.get(environmentId);
  const environmentBots = sortBotsForSidebar(
    bots.filter((entry) => entry.environmentId === environmentId),
  );

  if (environmentId === null || settings === undefined) {
    return (
      <SettingsPageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>
              <T>Bots aren’t available</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Connect to an environment whose server supports Bots.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {environmentIds.length > 1 ? (
        <Select
          value={environmentId}
          onValueChange={(id) => {
            if (id !== null) setChosenEnvironmentId(id);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={gt("Environment", { $context: "a T3 Code server to pick" })}
          >
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
      ) : null}

      <SettingsSection
        {...setting("bots")}
        headerAction={
          <Button size="xs" variant="ghost-muted" onClick={openNewBotDialog}>
            <PlusIcon className="size-3" />
            <T>New Bot</T>
          </Button>
        }
      >
        {environmentBots.length === 0 ? (
          <SettingsRow
            title={gt("No Bots yet")}
            description={gt(
              "A Bot is a long-lived thread with a name, a face, standing instructions and a memory it keeps up to date.",
            )}
          />
        ) : (
          environmentBots.map(({ bot }) => (
            <Link
              key={bot.id}
              to="/bots/$botId"
              params={{ botId: bot.id }}
              className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <BotAvatar avatar={bot.avatar} name={bot.name} className="size-8 rounded-lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {bot.name}
                </span>
                {bot.role ? (
                  <span className="block truncate text-xs text-muted-foreground">{bot.role}</span>
                ) : null}
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))
        )}
      </SettingsSection>

      <BotsSharedSettingsSections
        key={environmentId}
        environmentId={environmentId}
        settings={settings}
      />
    </SettingsPageContainer>
  );
}

function BotsSharedSettingsSections({
  environmentId,
  settings,
}: {
  environmentId: EnvironmentId;
  settings: BotsSharedSettings;
}) {
  const gt = useGT();
  const messages = useMessages();
  const setting = useSearchableSetting();
  const canSave = useAtomValue(serverEnvironment.saveBotSettings.permissionAtom(environmentId));
  const saveSettings = useAtomCommand(serverEnvironment.saveBotSettings, {
    label: "bot save settings",
    reportFailure: false,
  });
  const memoryQuery = useEnvironmentQuery(
    serverEnvironment.botMemory({ environmentId, input: {} }),
    messages,
  );
  const [userName, setUserName] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [alwaysAsk, setAlwaysAsk] = useState<string | null>(null);
  const [allowWithoutAsking, setAllowWithoutAsking] = useState<string | null>(null);
  const shownTimezone = timezone ?? settings.timezone;
  const timezoneInvalid = shownTimezone.trim() !== "" && !isTimeZone(shownTimezone.trim());

  const save = async (patch: BotSaveSettingsInput): Promise<boolean> => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    const result = await saveSettings({ environmentId, input: patch });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not save Bot settings"),
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        }),
      );
    }
    return false;
  };

  const commitUserName = () => {
    if (userName === null) return;
    const next = userName.trim();
    if (next === settings.userName) return setUserName(null);
    void save({ userName: next }).then((saved) => saved && setUserName(null));
  };
  const commitTimezone = (value: string | null = timezone) => {
    if (value === null) return;
    const next = value.trim();
    if (next !== "" && !isTimeZone(next)) return;
    if (next === settings.timezone) return setTimezone(null);
    void save({ timezone: next }).then((saved) => saved && setTimezone(null));
  };
  const commitRules = (field: "alwaysAsk" | "allowWithoutAsking", text: string | null) => {
    if (text === null) return;
    const next = parseBotRuleList(text);
    const clear = () => (field === "alwaysAsk" ? setAlwaysAsk : setAllowWithoutAsking)(null);
    if (next.join("\n") === settings[field].join("\n")) return clear();
    void save({ [field]: next }).then((saved) => saved && clear());
  };

  return (
    <>
      <SettingsSection {...setting("bots-about-you")}>
        <SettingsRow
          title={gt("Your name")}
          description={gt("How your Bots address you.")}
          control={
            <Input
              aria-label={gt("Your name")}
              value={userName ?? settings.userName}
              disabled={!canSave}
              onChange={(event) => setUserName(event.target.value)}
              onBlur={commitUserName}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          }
        />
        <SettingsRow
          title={gt("Time zone")}
          description={
            timezoneInvalid
              ? gt("Use an IANA time zone, such as America/Sao_Paulo.")
              : gt("Routines and dates your Bots mention use it. Empty uses the server's time.")
          }
          control={
            <div className="flex w-full items-center gap-2">
              <Input
                aria-label={gt("Time zone")}
                aria-invalid={timezoneInvalid || undefined}
                value={shownTimezone}
                placeholder={gt("Server time")}
                disabled={!canSave}
                onChange={(event) => setTimezone(event.target.value)}
                onBlur={() => commitTimezone()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              {deviceTimeZone() !== settings.timezone ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canSave}
                  onClick={() => commitTimezone(deviceTimeZone())}
                >
                  <T>Use this device’s</T>
                </Button>
              ) : null}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection {...setting("bots-permissions")}>
        <SettingsRow
          title={gt("Always ask first")}
          description={gt(
            "One per line. Bots check with you before doing these, such as sending email or spending money.",
          )}
        >
          <div className="px-4 pb-4">
            <Textarea
              aria-label={gt("Always ask first")}
              rows={4}
              value={alwaysAsk ?? settings.alwaysAsk.join("\n")}
              disabled={!canSave}
              placeholder={gt("Send an email on my behalf")}
              onChange={(event) => setAlwaysAsk(event.target.value)}
              onBlur={() => commitRules("alwaysAsk", alwaysAsk)}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title={gt("OK without asking")}
          description={gt("One per line. Bots may do these on their own.")}
        >
          <div className="px-4 pb-4">
            <Textarea
              aria-label={gt("OK without asking")}
              rows={4}
              value={allowWithoutAsking ?? settings.allowWithoutAsking.join("\n")}
              disabled={!canSave}
              placeholder={gt("Read my calendar")}
              onChange={(event) => setAllowWithoutAsking(event.target.value)}
              onBlur={() => commitRules("allowWithoutAsking", allowWithoutAsking)}
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <BotSharedMemoryEditor
        environmentId={environmentId}
        file={memoryQuery.data?.shared ?? null}
        loadedAt={memoryQuery.dataUpdatedAt}
        error={memoryQuery.error}
        cwd={undefined}
        onReload={memoryQuery.refresh}
      />

      <BotConnectedAppsSettings environmentId={environmentId} />

      <BotVaultSettings environmentId={environmentId} />
    </>
  );
}
