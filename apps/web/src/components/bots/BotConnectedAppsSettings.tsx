// Settings › Bots › Connected apps. Adapted from Threebot web/src/components/ConnectApps.tsx and
// ExecutorConnectCard.tsx (MIT, Copyright (c) 2026 Threebot contributors).
import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type BotExecutorApp,
  type BotExecutorCatalogEntry,
  type BotsExecutorBackend,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSearchableSetting } from "../settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function BotConnectedAppsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const messages = useMessages();
  const setting = useSearchableSetting();
  const saved = useServerConfigs().get(environmentId)?.settings.botsExecutor;
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "bots executor settings",
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    serverEnvironment.botExecutorStatus({ environmentId, input: {} }),
    messages,
  );
  const [draft, setDraft] = useState<{
    backend?: BotsExecutorBackend;
    url?: string;
    organization?: string;
    mcpUrl?: string;
    publicUrl?: string;
    token?: string;
    skippedApps?: string;
  }>({});
  const [saving, setSaving] = useState(false);
  if (saved === undefined) return null;
  const backend = draft.backend ?? saved.backend;
  const value = (key: "url" | "organization" | "mcpUrl" | "publicUrl") => draft[key] ?? saved[key];
  const skipped = draft.skippedApps ?? saved.skippedApps.join(", ");
  const hasToken = saved.token !== "";
  const changed = Object.keys(draft).length > 0;
  const configured = status.data?.configured === true;

  const save = async (patch: Record<string, unknown>) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return false;
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { botsExecutor: patch } },
    });
    setSaving(false);
    if (result._tag === "Success") {
      status.refresh();
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not save Executor settings"),
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        }),
      );
    }
    return false;
  };

  const submit = async () => {
    const { token, skippedApps, ...rest } = draft;
    const patch = {
      ...rest,
      ...(token !== undefined && token.trim() !== "" ? { token: token.trim() } : {}),
      ...(skippedApps === undefined
        ? {}
        : {
            skippedApps: skippedApps
              .split(",")
              .map((name) => name.trim())
              .filter(Boolean),
          }),
    };
    if (await save(patch)) setDraft({});
  };

  const disconnectExecutor = async () => {
    if (await save({ url: "", organization: "", mcpUrl: "", publicUrl: "", token: "" })) {
      setDraft({});
    }
  };

  return (
    <>
      <SettingsSection
        {...setting("bots-connected-apps")}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={status.refresh}
            disabled={status.isPending}
            aria-label={gt("Check Executor again")}
          >
            <RefreshCwIcon className="size-3" />
            <T>Check</T>
          </Button>
        }
      >
        <SettingsRow
          title={gt("Executor")}
          description={gt(
            "Executor (executor.sh) holds your app accounts, such as Gmail, Calendar, Slack and GitHub, and gives every Bot one MCP server to use them. T3 writes it into each Bot's MCP config.",
          )}
          status={
            status.data === null ? null : status.data.ok ? (
              <Badge variant="success" size="sm">
                <T>Connected</T>
              </Badge>
            ) : status.data.configured ? (
              <span className="text-xs text-destructive-foreground">{status.data.error}</span>
            ) : null
          }
        />
        <SettingsRow
          title={gt("Where it runs")}
          control={
            <Select
              value={backend}
              disabled={!canEdit}
              onValueChange={(next) => {
                if (next !== null) setDraft((previous) => ({ ...previous, backend: next }));
              }}
            >
              <SelectTrigger size="sm" aria-label={gt("Where it runs")}>
                <SelectValue>
                  {backend === "cloud" ? gt("Executor Cloud") : gt("Self-hosted")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="self-hosted" label={gt("Self-hosted")}>
                  {gt("Self-hosted")}
                </SelectItem>
                <SelectItem value="cloud" label={gt("Executor Cloud")}>
                  {gt("Executor Cloud")}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <ExecutorTextRow
          title={backend === "cloud" ? gt("API address (optional)") : gt("Address")}
          placeholder={backend === "cloud" ? "https://app.executor.sh" : "http://localhost:4000"}
          value={value("url")}
          disabled={!canEdit}
          onChange={(url) => setDraft((previous) => ({ ...previous, url }))}
        />
        <ExecutorTextRow
          title={backend === "cloud" ? gt("Organization") : gt("Organization (optional)")}
          placeholder={backend === "cloud" ? "acme" : "executor"}
          value={value("organization")}
          disabled={!canEdit}
          onChange={(organization) => setDraft((previous) => ({ ...previous, organization }))}
        />
        <ExecutorTextRow
          title={gt("MCP address (optional)")}
          placeholder={gt("Derived from the address")}
          value={value("mcpUrl")}
          disabled={!canEdit}
          onChange={(mcpUrl) => setDraft((previous) => ({ ...previous, mcpUrl }))}
        />
        <ExecutorTextRow
          title={gt("Sign-in address (optional)")}
          placeholder={gt("Same as the address")}
          value={value("publicUrl")}
          disabled={!canEdit}
          onChange={(publicUrl) => setDraft((previous) => ({ ...previous, publicUrl }))}
        />
        <SettingsRow
          title={gt("Access token")}
          description={gt(
            "Kept in the server's secret store. Bots' harnesses read it from their own MCP config files, which only your user can read.",
          )}
          control={
            <Input
              type="password"
              autoComplete="off"
              aria-label={gt("Access token")}
              placeholder={hasToken ? gt("Saved; type to replace") : ""}
              value={draft.token ?? ""}
              disabled={!canEdit}
              onChange={(event) => {
                const token = event.target.value;
                setDraft((previous) => ({ ...previous, token }));
              }}
            />
          }
        />
        {backend === "cloud" ? (
          <ExecutorTextRow
            title={gt("Skipped apps")}
            placeholder={gt("Apps Bots shouldn't ask you to connect, comma separated")}
            value={skipped}
            disabled={!canEdit}
            onChange={(skippedApps) => setDraft((previous) => ({ ...previous, skippedApps }))}
          />
        ) : null}
        <div className="flex items-center gap-2 px-4 py-3">
          {hasToken || saved.url !== "" || saved.organization !== "" ? (
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!canEdit || saving}
              onClick={() => void disconnectExecutor()}
            >
              <T>Remove Executor</T>
            </Button>
          ) : null}
          <span className="flex-1" />
          {changed ? (
            <Button size="sm" variant="ghost" onClick={() => setDraft({})}>
              <T>Cancel</T>
            </Button>
          ) : null}
          <Button size="sm" disabled={!canEdit || !changed || saving} onClick={() => void submit()}>
            <T>Save</T>
          </Button>
        </div>
      </SettingsSection>
      {configured && status.data?.ok ? <ExecutorApps environmentId={environmentId} /> : null}
    </>
  );
}

function ExecutorTextRow(props: {
  title: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsRow
      title={props.title}
      control={
        <Input
          aria-label={props.title}
          placeholder={props.placeholder}
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value)}
        />
      }
    />
  );
}

function AppIcon({ name, icon }: { name: string; icon: string | null | undefined }) {
  return icon ? (
    <img
      src={icon}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="size-6 shrink-0 rounded-md bg-white object-contain p-0.5"
    />
  ) : (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ExecutorApps({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const messages = useMessages();
  const canEdit = useAtomValue(
    serverEnvironment.connectBotExecutorApp.permissionAtom(environmentId),
  );
  const apps = useEnvironmentQuery(
    serverEnvironment.botExecutorConnections({ environmentId, input: {} }),
    messages,
  );
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const catalog = useEnvironmentQuery(
    catalogOpen ? serverEnvironment.botExecutorCatalog({ environmentId, input: {} }) : null,
    messages,
  );
  const connect = useAtomCommand(serverEnvironment.connectBotExecutorApp, {
    label: "bots executor connect",
    reportFailure: false,
  });
  const disconnect = useAtomCommand(serverEnvironment.disconnectBotExecutorApp, {
    label: "bots executor disconnect",
    reportFailure: false,
  });
  const install = useAtomCommand(serverEnvironment.installBotExecutorApp, {
    label: "bots executor install",
    reportFailure: false,
  });
  const fail = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure") return;
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      }),
    );
  };

  const startConnect = async (
    app: BotExecutorApp,
    requirement: BotExecutorApp["requirements"][number],
  ) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    // Opened first, inside the click, so a popup blocker lets it through.
    const opened = window.open("about:blank", "_blank");
    const result = await connect({
      environmentId,
      input: { appId: app.id, requirement: requirement.id, scope: requirement.scope },
    });
    if (result._tag === "Success") {
      if (opened) opened.location.href = result.value.url;
      else window.open(result.value.url, "_blank", "noopener");
      return;
    }
    opened?.close();
    fail(gt("Could not start connecting {name}", { name: app.name }), result);
  };

  const unlink = async (
    app: BotExecutorApp,
    requirement: BotExecutorApp["requirements"][number],
    account: string,
  ) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const result = await disconnect({
      environmentId,
      input: { appId: app.id, requirement: requirement.id, scope: requirement.scope, account },
    });
    if (result._tag === "Success") apps.refresh();
    else fail(gt("Could not disconnect {name}", { name: app.name }), result);
  };

  const add = async (entry: BotExecutorCatalogEntry) => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const result = await install({ environmentId, input: { entry: entry.id, name: entry.name } });
    if (result._tag === "Success") apps.refresh();
    else fail(gt("Could not add {name}", { name: entry.name }), result);
  };

  const installed = new Set((apps.data?.apps ?? []).map((app) => app.name.toLowerCase()));
  const query = search.trim().toLowerCase();
  const entries = (catalog.data?.entries ?? [])
    .filter(
      (entry) =>
        !installed.has(entry.name.toLowerCase()) &&
        (query === "" ||
          entry.name.toLowerCase().includes(query) ||
          entry.description.toLowerCase().includes(query)),
    )
    .slice(0, 50);

  return (
    <SettingsSection
      title={gt("Apps")}
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={() => setCatalogOpen((open) => !open)}>
          {catalogOpen ? <T>Done</T> : <T>Add apps</T>}
        </Button>
      }
    >
      {apps.error ? <SettingsRow title={gt("Apps")} description={apps.error} /> : null}
      {apps.data !== null && apps.data.apps.length === 0 ? (
        <SettingsRow
          title={gt("No apps yet")}
          description={gt("Add one here, or ask a Bot to connect it for you.")}
        />
      ) : null}
      {(apps.data?.apps ?? []).map((app) => (
        <div key={app.id} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <AppIcon name={app.name} icon={app.icon} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{app.name}</span>
            <Badge
              size="sm"
              variant={
                app.status === "connected"
                  ? "success"
                  : app.status === "needs-connection"
                    ? "warning"
                    : "secondary"
              }
            >
              {app.status === "connected"
                ? gt("Connected")
                : app.status === "needs-connection"
                  ? gt("Needs sign-in")
                  : app.status === "ready"
                    ? gt("Ready")
                    : gt("Unavailable")}
            </Badge>
          </div>
          {app.requirements.map((requirement) => (
            <div
              key={`${requirement.scope}:${requirement.id}`}
              className="flex flex-wrap items-center gap-2 ps-9"
            >
              <span className="text-xs text-muted-foreground">{requirement.name}</span>
              {requirement.accounts
                .filter((account) => account.linked)
                .map((account) => (
                  <span key={account.id} className="inline-flex items-center gap-1 text-xs">
                    {account.name}
                    {account.signIn === "reconnect" ? (
                      <Badge size="sm" variant="warning">
                        <T>Sign in again</T>
                      </Badge>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!canEdit}
                      onClick={() => void unlink(app, requirement, account.id)}
                    >
                      <T>Disconnect</T>
                    </Button>
                  </span>
                ))}
              <span className="flex-1" />
              <Button
                size="xs"
                variant="outline"
                disabled={!canEdit}
                onClick={() => void startConnect(app, requirement)}
              >
                <T>Connect</T>
              </Button>
            </div>
          ))}
        </div>
      ))}
      {catalogOpen ? (
        <div className="flex flex-col gap-2 px-4 py-3">
          <Input
            type="search"
            aria-label={gt("Search apps")}
            placeholder={gt("Search apps")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {catalog.error ? (
            <p className="text-xs text-destructive-foreground">{catalog.error}</p>
          ) : null}
          {catalog.data === null && catalog.error === null ? (
            <p className="text-xs text-muted-foreground">
              <T>Loading the catalog…</T>
            </p>
          ) : null}
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-1.5">
                <AppIcon name={entry.name} icon={entry.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{entry.name}</span>
                  {entry.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.description}
                    </span>
                  ) : null}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canEdit}
                  onClick={() => void add(entry)}
                >
                  <T>Add</T>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SettingsSection>
  );
}
