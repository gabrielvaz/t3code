// A room's chat view. Adapted from Threebot web/src/components/RoomView.tsx and MentionMenu.tsx
// (MIT, Copyright (c) 2026 Threebot contributors).
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_ROOM_MESSAGE_MAX_CHARS,
  type Bot,
  type BotRoomMemberState,
  type BotRoomTranscriptEntry,
} from "@t3tools/contracts";
import { addressedMembers, mentionQueryAt } from "@t3tools/shared/botMentions";
import { Link, useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  MessagesSquareIcon,
  RotateCcwIcon,
  SendIcon,
  SettingsIcon,
  SquareIcon,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { m } from "../../i18n/messages";
import { useEnvironmentBots } from "../../state/bots";
import { type EnvironmentBotRoom, useEnvironmentBotRoom } from "../../state/botRooms";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { BotAvatar } from "./BotAvatar";
import { BotRoomSettingsSheet } from "./BotRoomSettingsSheet";
import { cn } from "~/lib/utils";

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? undefined,
    }),
  );

export function BotRoomPage({ roomId }: { roomId: string }) {
  const entry = useEnvironmentBotRoom(roomId);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {entry === null ? (
          <>
            <WorkspacePageHeader electron={isElectron} className="border-b" />
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessagesSquareIcon />
                </EmptyMedia>
                <EmptyTitle>
                  <T>This room is gone</T>
                </EmptyTitle>
                <EmptyDescription>
                  <T>It was deleted, or its server is not connected.</T>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </>
        ) : (
          <RoomView key={`${entry.environmentId}:${entry.room.id}`} entry={entry} />
        )}
      </div>
    </SidebarInset>
  );
}

function RoomView({ entry }: { entry: EnvironmentBotRoom }) {
  const gt = useGT();
  const router = useRouter();
  const stateLabels: Record<BotRoomMemberState, string> = {
    waiting: gt("Waiting", { $context: "a Bot waits for its turn in a room" }),
    thinking: gt("Thinking…", { $context: "a Bot is answering in a room" }),
    replied: gt("Replied", { $context: "a Bot answered in a room" }),
    passed: gt("Passed", { $context: "a Bot had nothing to add in a room" }),
    "no-reply": gt("No reply", { $context: "a Bot ended its turn without a message" }),
    timeout: gt("Timed out", { $context: "a Bot took too long in a room" }),
    failed: gt("Failed", { $context: "a Bot's turn in a room failed" }),
    stopped: gt("Stopped", { $context: "a Bot's turn in a room was stopped" }),
  };
  const { room, environmentId, status } = entry;
  const { bots } = useEnvironmentBots();
  const environmentBots = bots
    .filter((candidate) => candidate.environmentId === environmentId)
    .map((candidate) => candidate.bot);
  const botById = new Map(environmentBots.map((bot) => [bot.id as string, bot]));
  const members = room.members.flatMap((member) => {
    const bot = botById.get(member.botId);
    return bot === undefined ? [] : [{ member, bot }];
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const busy = status?.turnId != null;
  const canOperate = useAtomValue(
    serverEnvironment.sendBotRoomMessage.permissionAtom(environmentId),
  );
  const stopRoom = useAtomCommand(serverEnvironment.stopBotRoom, {
    label: "bot room stop",
    reportFailure: false,
  });
  const resetRoom = useAtomCommand(serverEnvironment.resetBotRoom, {
    label: "bot room reset",
    reportFailure: false,
  });
  const deleteRoom = useAtomCommand(serverEnvironment.deleteBotRoom, {
    label: "bot room delete",
    reportFailure: false,
  });
  const stateOf = new Map(status?.members.map((member) => [member.botId as string, member.state]));

  const stop = async () => {
    const result = await stopRoom({ environmentId, input: { id: room.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure(gt("Could not stop the room"), squashAtomCommandFailure(result));
  };
  const reset = async () => {
    const message = `${gt("Start #{name} over?", { name: room.name })}\n${gt(
      "The room forgets its messages and every Bot starts a fresh session. Their threads keep the history.",
    )}`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await resetRoom({ environmentId, input: { id: room.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      reportFailure(gt("Could not reset the room"), squashAtomCommandFailure(result));
  };
  const remove = async () => {
    const message = `${gt("Delete #{name}?", { name: room.name })}\n${gt(
      "The room and its members' room threads are deleted. The Bots themselves stay.",
    )}`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await deleteRoom({ environmentId, input: { id: room.id } });
    if (result._tag === "Success") {
      setSettingsOpen(false);
      void router.navigate({ to: "/" });
      return;
    }
    if (!isAtomCommandInterrupted(result))
      reportFailure(gt("Could not delete the room"), squashAtomCommandFailure(result));
  };

  return (
    <>
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <WorkspaceBreadcrumb ariaLabel={gt("Room breadcrumb")} className="flex-1">
          <WorkspaceBreadcrumbItem>
            <Link
              to="/settings/bots"
              className="inline-flex min-w-0 max-w-full items-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <WorkspaceBreadcrumbText>
                <T>Bots</T>
              </WorkspaceBreadcrumbText>
            </Link>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator>
            <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbSeparator>
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
            <h1 className="min-w-0">
              <WorkspaceBreadcrumbText>#{room.name}</WorkspaceBreadcrumbText>
            </h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {busy ? (
          <Button size="sm" variant="outline" disabled={!canOperate} onClick={() => void stop()}>
            <SquareIcon />
            <T>Stop</T>
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("Start the room over")}
          disabled={!canOperate}
          onClick={() => void reset()}
        >
          <RotateCcwIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("Room settings")}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon />
        </Button>
      </WorkspacePageHeader>
      <ul
        aria-label={gt("Room members")}
        className="flex flex-wrap items-center gap-2 border-b px-4 py-2"
      >
        {members.map(({ member, bot }) => {
          const state = stateOf.get(bot.id);
          const label = state === undefined ? null : stateLabels[state];
          return (
            <li key={bot.id}>
              {member.threadId === null ? (
                <MemberChip bot={bot} label={label} active={state === "thinking"} />
              ) : (
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams(scopeThreadRef(environmentId, member.threadId))}
                  className="block rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  title={gt("Open {name}'s room thread", { name: bot.name })}
                >
                  <MemberChip bot={bot} label={label} active={state === "thinking"} />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <RoomTranscript entry={entry} botById={botById} />
      <RoomComposer entry={entry} members={members.map(({ bot }) => bot)} />
      {settingsOpen ? (
        <BotRoomSettingsSheet
          entry={entry}
          bots={environmentBots}
          onClose={() => setSettingsOpen(false)}
          onDelete={() => void remove()}
        />
      ) : null}
    </>
  );
}

function MemberChip({ bot, label, active }: { bot: Bot; label: string | null; active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border ps-1 pe-2.5 text-xs",
        active ? "border-primary/40 bg-primary/8" : "bg-muted/40",
      )}
    >
      <BotAvatar avatar={bot.avatar} name={bot.name} className="size-5 rounded-full" />
      <span className="font-medium">{bot.name}</span>
      {label === null ? null : <span className="text-muted-foreground">· {label}</span>}
    </span>
  );
}

function RoomTranscript({
  entry,
  botById,
}: {
  entry: EnvironmentBotRoom;
  botById: ReadonlyMap<string, Bot>;
}) {
  const transcript = useEnvironmentQuery(
    serverEnvironment.botRoomTranscript({
      environmentId: entry.environmentId,
      input: { id: entry.room.id },
    }),
  );
  const entries = transcript.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          {transcript.error ?? (
            <T>Say hello. Name a Bot with @ to ask it directly, or @all to hear from everyone.</T>
          )}
        </p>
      </div>
    );
  }
  // Reversed in a column-reverse box: the view stays pinned to the newest message.
  return (
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto scrollbar-gutter-both">
      <ol className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        {transcript.data?.truncated ? (
          <li className="text-center text-xs text-muted-foreground">
            <T>Older messages are in each Bot's room thread.</T>
          </li>
        ) : null}
        {entries.map((line) => (
          <TranscriptLine
            key={line.id}
            line={line}
            bot={line.botId ? botById.get(line.botId) : undefined}
            environmentId={entry.environmentId}
          />
        ))}
      </ol>
    </div>
  );
}

function TranscriptLine({
  line,
  bot,
  environmentId,
}: {
  line: BotRoomTranscriptEntry;
  bot: Bot | undefined;
  environmentId: EnvironmentBotRoom["environmentId"];
}) {
  const gt = useGT();
  if (line.botId === undefined) {
    return (
      <li className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm whitespace-pre-wrap">
          {line.text}
        </div>
      </li>
    );
  }
  const name = bot?.name ?? gt("A former member");
  return (
    <li className="flex gap-3">
      {bot === undefined ? (
        <span aria-hidden className="size-7 shrink-0 rounded-full bg-muted" />
      ) : (
        <BotAvatar avatar={bot.avatar} name={bot.name} className="size-7 rounded-full" />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-xs font-medium text-muted-foreground">{name}</div>
        <ChatMarkdown text={line.text} cwd={undefined} environmentId={environmentId} />
      </div>
    </li>
  );
}

function RoomComposer({
  entry,
  members,
}: {
  entry: EnvironmentBotRoom;
  members: ReadonlyArray<Bot>;
}) {
  const gt = useGT();
  const { room, environmentId } = entry;
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = useAtomValue(serverEnvironment.sendBotRoomMessage.permissionAtom(environmentId));
  const sendMessage = useAtomCommand(serverEnvironment.sendBotRoomMessage, {
    label: "bot room send",
    reportFailure: false,
  });
  const names = members.map((bot) => bot.name);
  const query = mentionQueryAt(text, cursor, names);
  const everyone = { id: "all", name: "all", role: gt("Everyone in the room") };
  const options =
    query === null
      ? []
      : [
          ...members.map((bot) => ({ id: bot.id as string, name: bot.name, role: bot.role })),
          everyone,
        ].filter((option) => option.name.toLowerCase().startsWith(query.query.toLowerCase()));
  const highlighted = Math.min(activeIndex, Math.max(0, options.length - 1));

  const pick = (option: { name: string }) => {
    if (query === null) return;
    const next = `${text.slice(0, query.start)}@${option.name} ${text.slice(cursor)}`;
    const caret = query.start + option.name.length + 2;
    setText(next);
    setCursor(caret);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  const send = async () => {
    const message = text.trim();
    if (message.length === 0 || sending || !canSend) return;
    const addressed = addressedMembers(
      message,
      members.map((bot) => ({ id: bot.id, name: bot.name })),
      "anywhere",
    );
    setSending(true);
    const result = await sendMessage({
      environmentId,
      input: {
        id: room.id,
        text: message,
        ...(addressed.all
          ? { mentions: ["all"] }
          : addressed.ids.length > 0
            ? { mentions: [...addressed.ids] }
            : {}),
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
      setCursor(0);
      return;
    }
    if (!isAtomCommandInterrupted(result))
      reportFailure(gt("Could not send to the room"), squashAtomCommandFailure(result));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((highlighted + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const option = options[highlighted];
        if (option !== undefined) {
          event.preventDefault();
          pick(option);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCursor(-1);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const listboxId = `room-mentions-${room.id}`;
  return (
    <form
      className="border-t px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="relative mx-auto flex max-w-3xl items-end gap-2">
        {options.length > 0 ? (
          <div
            id={listboxId}
            role="listbox"
            aria-label={gt("Bots to mention")}
            className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-60 overflow-y-auto rounded-xl border bg-popover p-1 shadow-lg"
          >
            {options.map((option, index) => {
              const bot = members.find((candidate) => candidate.id === option.id);
              return (
                <div
                  key={option.id}
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                  className={cn(
                    "flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm select-none",
                    index === highlighted && "bg-accent",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(option);
                  }}
                >
                  {bot === undefined ? (
                    <MessagesSquareIcon className="size-5 text-muted-foreground" />
                  ) : (
                    <BotAvatar
                      avatar={bot.avatar}
                      name={bot.name}
                      className="size-5 rounded-full"
                    />
                  )}
                  <span className="font-medium">@{option.name}</span>
                  {option.role ? (
                    <span className="truncate text-xs text-muted-foreground">{option.role}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
        <Textarea
          ref={textareaRef}
          rows={1}
          className="flex-1"
          aria-label={gt("Message #{name}", { name: room.name })}
          aria-controls={options.length > 0 ? listboxId : undefined}
          aria-activedescendant={options.length > 0 ? `${listboxId}-${highlighted}` : undefined}
          placeholder={gt("Message #{name}", { name: room.name })}
          maxLength={BOT_ROOM_MESSAGE_MAX_CHARS}
          disabled={!canSend}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCursor(event.target.selectionStart);
            setActiveIndex(0);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <Button
          type="submit"
          size="icon"
          aria-label={gt("Send")}
          disabled={!canSend || sending || text.trim().length === 0}
        >
          <SendIcon />
        </Button>
      </div>
    </form>
  );
}
