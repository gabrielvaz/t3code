import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { BotIcon, LayoutListIcon, MessagesSquareIcon, PinIcon, PlusIcon } from "lucide-react";
import { memo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";

import { contextMenuSourceOf, openContextMenuFromKeyboard } from "../../contextMenuSource";
import { readLocalApi } from "../../localApi";
import { cn } from "~/lib/utils";
import { openNewBotDialog, type EnvironmentBot } from "../../state/bots";
import { openNewBotRoomDialog, type EnvironmentBotRoom } from "../../state/botRooms";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { BotAvatar } from "../bots/BotAvatar";
import { useBoardEnvironmentIds } from "../bots/useBoardEnvironmentIds";
import { useBotActions } from "../bots/useBotActions";
import {
  hasUnseenCompletion,
  resolveSidebarRowAccessibility,
  resolveSidebarRowStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { BotRoomAvatars } from "../bots/BotRoomAvatars";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { TopStatusIcon, useSidebarTopStatus } from "./SidebarThreadRow";

type RevealRef = (row: HTMLElement, rowKey: string) => (() => void) | undefined;

const SidebarBotRow = memo(function SidebarBotRow(props: {
  entry: EnvironmentBot;
  isActive: boolean;
  revealRef: RevealRef | undefined;
  onNavigate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    entry: EnvironmentBot,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const { entry, onNavigate, onContextMenu, revealRef } = props;
  const { bot, environmentId } = entry;
  const gt = useGT();
  const threadRef = bot.threadId === null ? null : scopeThreadRef(environmentId, bot.threadId);
  const rowKey = threadRef === null ? `bot:${bot.id}` : scopedThreadKey(threadRef);
  const thread = useThreadShell(threadRef);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[rowKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread?.lastVisitedAt, localLastVisitedAt);
  const statusInput = thread === null ? null : { ...thread, lastVisitedAt };
  const topStatus = useSidebarTopStatus({
    status: statusInput === null ? "ready" : resolveSidebarRowStatus(statusInput),
    goalActive: thread?.goal?.status === "active",
    isWoke: false,
    isUnread: statusInput !== null && hasUnseenCompletion(statusInput),
  });
  const accessibility = resolveSidebarRowAccessibility({
    title: bot.name,
    statusLabel: topStatus?.label ?? null,
    projectDisplayName: bot.role || null,
    isActive: props.isActive,
  });
  const activate = () => {
    if (threadRef !== null) onNavigate(threadRef);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    openContextMenuFromKeyboard(event);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };
  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    onContextMenu(entry, { x: event.clientX, y: event.clientY }, contextMenuSourceOf(event));
  };
  return (
    <li className="list-none">
      <div
        ref={(row) => (row === null ? undefined : revealRef?.(row, rowKey))}
        role="button"
        tabIndex={0}
        data-sidebar-row={rowKey}
        data-testid="sidebar-bot-row"
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        aria-disabled={threadRef === null || undefined}
        className={cn(
          "group/sidebar-row relative flex h-9 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={activate}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <BotAvatar avatar={bot.avatar} name={bot.name} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{bot.name}</span>
        {bot.pinned ? (
          <PinIcon
            aria-label={gt("Pinned")}
            className="size-3 shrink-0 text-sidebar-muted-foreground"
          />
        ) : null}
        {topStatus ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              topStatus.className,
            )}
          >
            <TopStatusIcon icon={topStatus.icon} className="size-3.5" />
            {topStatus.label}
          </span>
        ) : null}
      </div>
    </li>
  );
});

const SidebarRoomRow = memo(function SidebarRoomRow(props: {
  entry: EnvironmentBotRoom;
  bots: ReadonlyArray<EnvironmentBot>;
  isActive: boolean;
  onOpen: (entry: EnvironmentBotRoom) => void;
}) {
  const { entry, isActive, onOpen } = props;
  const gt = useGT();
  const busy = entry.status?.turnId != null;
  const members = entry.room.members.flatMap(
    (member) =>
      props.bots.find(
        (bot) => bot.environmentId === entry.environmentId && bot.bot.id === member.botId,
      )?.bot ?? [],
  );
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-bot-room-row"
        aria-current={isActive ? "page" : undefined}
        aria-label={
          busy ? gt("#{name}, replying", { name: entry.room.name }) : `#${entry.room.name}`
        }
        className={cn(
          "group/sidebar-row relative flex h-9 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
        onClick={() => onOpen(entry)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(entry);
          }
        }}
      >
        <BotRoomAvatars bots={members} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">#{entry.room.name}</span>
        {busy ? (
          <span className="shrink-0 text-xs font-medium text-sidebar-muted-foreground">
            {gt("Replying", { $context: "a room's Bots are answering" })}
          </span>
        ) : null}
      </div>
    </li>
  );
});

/** The Bots section at the top of the thread list, shown once an environment has a Bot. */
export const SidebarBotsBlock = memo(function SidebarBotsBlock(props: {
  bots: ReadonlyArray<EnvironmentBot>;
  rooms: ReadonlyArray<EnvironmentBotRoom>;
  routeRowThreadKey: string | null;
  revealRef: RevealRef;
  onNavigate: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { update, confirmAndDelete } = useBotActions();
  const canCreate = useAtomValue(
    serverEnvironment.createBot.permissionAtom(props.bots[0]?.environmentId ?? null),
  );
  const boardOn = useBoardEnvironmentIds().length > 0;
  const { roomId: activeRoomId } = useParams({ strict: false });
  if (props.bots.length === 0) return null;
  const openRoom = (entry: EnvironmentBotRoom) =>
    void navigate({ to: "/bots/rooms/$roomId", params: { roomId: entry.room.id } });

  const showContextMenu = (
    entry: EnvironmentBot,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            { id: "open-page", label: gt("Open Bot page"), icon: "settings" },
            entry.bot.pinned
              ? { id: "unpin", label: gt("Unpin Bot"), icon: "pin-off" }
              : { id: "pin", label: gt("Pin Bot"), icon: "pin" },
            {
              id: "delete",
              label: gt("Delete Bot"),
              icon: "trash",
              destructive: true,
              separatorBefore: true,
            },
          ] as const,
          position,
          source,
        ),
      );
      if (clicked._tag === "Failure") return;
      switch (clicked.value) {
        case "open-page":
          void navigate({ to: "/bots/$botId", params: { botId: entry.bot.id } });
          break;
        case "pin":
        case "unpin":
          void update(entry, { pinned: clicked.value === "pin" });
          break;
        case "delete":
          void confirmAndDelete(entry);
          break;
      }
    })();
  };

  return (
    <>
      <li className="flex h-8 list-none items-center gap-2 ps-2 pe-1 text-xs font-medium text-sidebar-muted-foreground">
        <span className="min-w-0 truncate">{gt("Bots", { $context: "sidebar section" })}</span>
        <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border/50" />
        {boardOn ? (
          <SharedTooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={gt("Projects board")}
                onClick={() => void navigate({ to: "/bots/board" })}
              />
            }
            label={gt("Projects board")}
          >
            <LayoutListIcon />
          </SharedTooltipTrigger>
        ) : null}
        <Menu>
          <SharedTooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={gt("New Bot or room")}
                    disabled={!canCreate}
                  />
                }
              />
            }
            label={gt("New Bot or room")}
          >
            <PlusIcon />
          </SharedTooltipTrigger>
          <MenuPopup side="bottom" align="end">
            <MenuItem onClick={openNewBotDialog}>
              <BotIcon />
              <T>New Bot</T>
            </MenuItem>
            <MenuItem onClick={openNewBotRoomDialog}>
              <MessagesSquareIcon />
              <T>New room</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      </li>
      {props.bots.map((entry) => {
        const rowKey =
          entry.bot.threadId === null
            ? null
            : scopedThreadKey(scopeThreadRef(entry.environmentId, entry.bot.threadId));
        const isActive = rowKey !== null && rowKey === props.routeRowThreadKey;
        return (
          <SidebarBotRow
            key={`${entry.environmentId}:${entry.bot.id}`}
            entry={entry}
            isActive={isActive}
            revealRef={isActive ? props.revealRef : undefined}
            onNavigate={props.onNavigate}
            onContextMenu={showContextMenu}
          />
        );
      })}
      {props.rooms.length > 0 ? (
        <li className="flex h-7 list-none items-center ps-2.5 text-2xs font-medium text-sidebar-muted-foreground">
          {gt("Rooms", { $context: "sidebar group of Bot group chats" })}
        </li>
      ) : null}
      {props.rooms.map((entry) => (
        <SidebarRoomRow
          key={`${entry.environmentId}:${entry.room.id}`}
          entry={entry}
          bots={props.bots}
          isActive={entry.room.id === activeRoomId}
          onOpen={openRoom}
        />
      ))}
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60" />
    </>
  );
});
