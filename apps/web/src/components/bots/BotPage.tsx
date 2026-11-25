import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  BOT_INSTRUCTIONS_MAX_CHARS,
  BOT_MEMORY_FILE_MAX_CHARS,
  type BotId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { BotIcon, MessageSquareIcon } from "lucide-react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironmentBot, type EnvironmentBot } from "../../state/bots";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { BotAvatar } from "./BotAvatar";
import { BotDetailsTab } from "./BotDetailsTab";
import { BotRoutinesTab } from "./BotRoutinesTab";
import { BotTextFileEditor } from "./BotTextFileEditor";
import { BOT_PAGE_TABS, type BotPageTab } from "./botPageSearch";

const TAB_LABELS: Readonly<Record<BotPageTab, string>> = {
  details: msg("Details", { $context: "Bot page tab" }),
  instructions: msg("Instructions", { $context: "Bot page tab" }),
  memory: msg("Memory", { $context: "Bot page tab" }),
  routines: msg("Routines", { $context: "Bot page tab" }),
};

export function BotPage({ botId, tab }: { botId: BotId | string; tab: BotPageTab }) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const entry = useEnvironmentBot(botId);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel={gt("Bot breadcrumb")} className="flex-1">
            <WorkspaceBreadcrumbItem>
              <Link
                to="/settings/bots"
                className="inline-flex min-w-0 max-w-full items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <WorkspaceBreadcrumbText>
                  <T>Bots</T>
                </WorkspaceBreadcrumbText>
              </Link>
            </WorkspaceBreadcrumbItem>
            {entry ? (
              <>
                <WorkspaceBreadcrumbSeparator>
                  <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
                </WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
                  <h1 className="flex min-w-0 items-center gap-2">
                    <BotAvatar avatar={entry.bot.avatar} name={entry.bot.name} className="size-4" />
                    <WorkspaceBreadcrumbText>{entry.bot.name}</WorkspaceBreadcrumbText>
                  </h1>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          {entry?.bot.threadId ? (
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams(
                    scopeThreadRef(entry.environmentId, entry.bot.threadId),
                  )}
                />
              }
            >
              <MessageSquareIcon />
              <T>Open chat</T>
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
          {entry === null ? (
            <BotMissing />
          ) : (
            <WorkspacePageContainer className="gap-5">
              <div className="flex items-center gap-4">
                <BotAvatar
                  avatar={entry.bot.avatar}
                  name={entry.bot.name}
                  className="size-14 rounded-xl"
                />
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold">{entry.bot.name}</p>
                  {entry.bot.role ? (
                    <p className="truncate text-sm text-muted-foreground">{entry.bot.role}</p>
                  ) : null}
                </div>
              </div>
              <div
                role="tablist"
                aria-label={gt("Bot sections")}
                className="flex gap-0.5 overflow-x-auto border-b"
              >
                {BOT_PAGE_TABS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={value === tab}
                    aria-controls={`bot-tab-${value}`}
                    onClick={() =>
                      void navigate({
                        to: "/bots/$botId",
                        params: { botId: entry.bot.id },
                        search: value === "details" ? {} : { tab: value },
                        replace: true,
                      })
                    }
                    className={cn(
                      "-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      value === tab
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {messages(TAB_LABELS[value])}
                  </button>
                ))}
              </div>
              <div role="tabpanel" id={`bot-tab-${tab}`}>
                {tab === "details" ? (
                  <BotDetailsTab key={entry.bot.id} entry={entry} />
                ) : tab === "instructions" ? (
                  <BotInstructionsTab key={entry.bot.id} entry={entry} />
                ) : tab === "memory" ? (
                  <BotMemoryTab key={entry.bot.id} entry={entry} />
                ) : (
                  <BotRoutinesTab
                    environmentId={entry.environmentId}
                    threadId={entry.bot.threadId}
                  />
                )}
              </div>
            </WorkspacePageContainer>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

function BotMissing() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BotIcon />
        </EmptyMedia>
        <EmptyTitle>
          <T>This Bot isn’t available</T>
        </EmptyTitle>
        <EmptyDescription>
          <T>It may have been deleted, or its environment is not connected.</T>
        </EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={() => void navigateToMainApp()}>
        <T>Back</T>
      </Button>
    </Empty>
  );
}

function useBotFolder(entry: EnvironmentBot): string | undefined {
  const project = useProject(
    entry.bot.projectId === null ? null : scopeProjectRef(entry.environmentId, entry.bot.projectId),
  );
  return project?.workspaceRoot;
}

function BotInstructionsTab({ entry }: { entry: EnvironmentBot }) {
  const gt = useGT();
  const messages = useMessages();
  const canEdit = useAtomValue(
    serverEnvironment.saveBotInstructions.permissionAtom(entry.environmentId),
  );
  const cwd = useBotFolder(entry);
  const query = useEnvironmentQuery(
    serverEnvironment.botInstructions({
      environmentId: entry.environmentId,
      input: { id: entry.bot.id },
    }),
    messages,
  );
  const saveInstructions = useAtomCommand(serverEnvironment.saveBotInstructions, {
    label: "bot save instructions",
    reportFailure: false,
  });
  return (
    <SettingsSection title={gt("Instructions")} hideTitle variant="plain">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <T>
            Standing instructions the Bot reads at the start of every session. Write them like a
            note to a new colleague: what it is responsible for, what to avoid, how to talk to you.
          </T>
        </p>
        <BotTextFileEditor
          label={gt("Instructions")}
          file={query.data}
          loadedAt={query.dataUpdatedAt}
          error={query.error}
          mode="edit"
          environmentId={entry.environmentId}
          cwd={cwd}
          maxLength={BOT_INSTRUCTIONS_MAX_CHARS}
          canEdit={canEdit}
          emptyText={gt("No instructions yet.")}
          placeholder={gt("e.g. Check my calendar every morning and tell me what needs preparing.")}
          onSave={(text, expectedRevision) =>
            saveInstructions({
              environmentId: entry.environmentId,
              input: { id: entry.bot.id, text, expectedRevision },
            })
          }
          onReload={query.refresh}
        />
      </div>
    </SettingsSection>
  );
}

function BotMemoryTab({ entry }: { entry: EnvironmentBot }) {
  const gt = useGT();
  const messages = useMessages();
  const canEdit = useAtomValue(serverEnvironment.saveBotMemory.permissionAtom(entry.environmentId));
  const cwd = useBotFolder(entry);
  const query = useEnvironmentQuery(
    serverEnvironment.botMemory({
      environmentId: entry.environmentId,
      input: { id: entry.bot.id },
    }),
    messages,
  );
  const saveMemory = useAtomCommand(serverEnvironment.saveBotMemory, {
    label: "bot save memory",
    reportFailure: false,
  });
  return (
    <div className="space-y-8">
      <SettingsSection title={gt("Bot memory")} variant="plain">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            <T>
              Notes this Bot keeps for itself. It updates them as it learns; you can correct them
              here.
            </T>
          </p>
          <BotTextFileEditor
            label={gt("Bot memory")}
            file={query.data?.bot ?? (query.data === null ? null : { text: "", revision: "" })}
            loadedAt={query.dataUpdatedAt}
            error={query.error}
            mode="view"
            environmentId={entry.environmentId}
            cwd={cwd}
            maxLength={BOT_MEMORY_FILE_MAX_CHARS}
            canEdit={canEdit && query.data?.bot != null}
            emptyText={gt("Nothing remembered yet.")}
            onSave={(text, expectedRevision) =>
              saveMemory({
                environmentId: entry.environmentId,
                input: { scope: "bot", id: entry.bot.id, text, expectedRevision },
              })
            }
            onReload={query.refresh}
          />
        </div>
      </SettingsSection>
      <BotSharedMemoryEditor
        environmentId={entry.environmentId}
        file={query.data?.shared ?? null}
        loadedAt={query.dataUpdatedAt}
        error={query.error}
        cwd={cwd}
        onReload={query.refresh}
      />
    </div>
  );
}

/** Shared memory every Bot on the environment reads; also edited from Settings › Bots. */
export function BotSharedMemoryEditor({
  environmentId,
  file,
  loadedAt,
  error,
  cwd,
  onReload,
}: {
  environmentId: EnvironmentBot["environmentId"];
  file: { readonly text: string; readonly revision: string } | null;
  loadedAt: number;
  error: string | null;
  cwd: string | undefined;
  onReload: () => void;
}) {
  const gt = useGT();
  const canEdit = useAtomValue(serverEnvironment.saveBotMemory.permissionAtom(environmentId));
  const saveMemory = useAtomCommand(serverEnvironment.saveBotMemory, {
    label: "bot save shared memory",
    reportFailure: false,
  });
  return (
    <SettingsSection title={gt("Shared memory")} variant="plain" id="bots-shared-memory">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <T>What every Bot on this environment should know about you and your work.</T>
        </p>
        <BotTextFileEditor
          label={gt("Shared memory")}
          file={file}
          loadedAt={loadedAt}
          error={error}
          mode="view"
          environmentId={environmentId}
          cwd={cwd}
          maxLength={BOT_MEMORY_FILE_MAX_CHARS}
          canEdit={canEdit}
          emptyText={gt("Nothing shared yet.")}
          onSave={(text, expectedRevision) =>
            saveMemory({
              environmentId,
              input: { scope: "shared", text, expectedRevision },
            })
          }
          onReload={onReload}
        />
      </div>
    </SettingsSection>
  );
}
