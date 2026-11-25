import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { CalendarClockIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useClientSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  RUN_STATUS_LABELS,
  ScheduledRelativeLabel,
  statusVariant,
} from "../settings/ScheduledTasksSettings";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Routines are the scheduled tasks bound to the Bot's thread; the Bot creates them from chat. */
export function BotRoutinesTab({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
    messages,
  );
  const tasks =
    threadId === null
      ? []
      : (tasksQuery.data?.tasks ?? []).filter((task) => task.threadId === threadId);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <T>
          Ask the Bot in chat to set one up, for example: “every weekday at 8am, summarize my
          inbox”.
        </T>
      </p>
      {tasksQuery.error !== null ? (
        <p className="text-sm text-destructive" role="status">
          {tasksQuery.error}
        </p>
      ) : tasksQuery.data === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          <T>Loading routines…</T>
        </p>
      ) : tasks.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClockIcon />
            </EmptyMedia>
            <EmptyTitle>
              <T>No routines yet</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Routines this Bot schedules for itself show up here.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SettingsSection title={gt("Routines")} hideTitle>
          {tasks.map((task) => (
            <BotRoutineRow
              key={task.id}
              environmentId={environmentId}
              task={task}
              timeZone={tasksQuery.data?.timeZone}
            />
          ))}
        </SettingsSection>
      )}
    </div>
  );
}

function BotRoutineRow({
  environmentId,
  task,
  timeZone,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
  timeZone: string | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot routine enabled",
    reportFailure: false,
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "bot routine run now",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "bot routine delete",
    reportFailure: false,
  });
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    if (action === "delete") {
      const message = `${gt('Delete "{title}"?', { title: task.title })}\n${gt("This cannot be undone.")}`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not update the routine"),
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {scheduleLabel(
              task.schedule,
              timestampFormat,
              timeZone,
              task.nextRunAt,
              messages,
              locale,
            )}
            {" · "}
            {!task.enabled ? (
              gt("Paused")
            ) : task.nextRunAt ? (
              <T>
                Next run <ScheduledRelativeLabel value={task.nextRunAt} />
              </T>
            ) : (
              gt("Not scheduled")
            )}
          </span>
          {task.lastRunStatus !== "never" ? (
            <Badge variant={statusVariant(task.lastRunStatus)}>
              {messages(RUN_STATUS_LABELS[task.lastRunStatus])}
            </Badge>
          ) : null}
          {task.lastRunError ? <span className="text-destructive">{task.lastRunError}</span> : null}
        </span>
      }
      control={
        <div className="flex items-center gap-1">
          <Switch
            checked={task.enabled}
            disabled={busy || !canOperate}
            aria-label={gt("Enable {title}", { title: task.title })}
            onCheckedChange={() => void act("toggle")}
          />
          {task.schedule.type === "webhook" ? null : (
            <SharedTooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={gt("Run {title} now", { title: task.title })}
                  disabled={busy || !canOperate || task.lastRunStatus === "running"}
                  onClick={() => void act("run")}
                />
              }
              label={gt("Run now")}
            >
              <PlayIcon />
            </SharedTooltipTrigger>
          )}
          <SharedTooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={gt("Edit {title}", { title: task.title })}
                render={
                  <Link
                    to="/settings/scheduled-tasks"
                    search={{ environmentId, taskId: task.id }}
                  />
                }
              />
            }
            label={gt("Edit in Scheduled tasks")}
          >
            <PencilIcon />
          </SharedTooltipTrigger>
          <SharedTooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-destructive"
                aria-label={gt("Delete {title}", { title: task.title })}
                disabled={busy || !canOperate}
                onClick={() => void act("delete")}
              />
            }
            label={gt("Delete routine")}
          >
            <Trash2Icon />
          </SharedTooltipTrigger>
        </div>
      }
    />
  );
}
