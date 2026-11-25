// The Projects board page (Labs beta). Layout adapted from Threebot web/src/components/Projects.tsx
// (MIT, Copyright (c) 2026 Threebot contributors).
import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  BOT_BOARD_KINDS,
  BOT_BOARD_PRIORITIES,
  BOT_BOARD_STATUSES,
  type BotBoardItem,
  type BotBoardKind,
  type BotBoardLink,
  type EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { AsyncResult } from "effect/reactivity";
import {
  ArchiveIcon,
  BotIcon,
  ExternalLinkIcon,
  LayoutListIcon,
  PinIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { m } from "../../i18n/messages";
import { useEnvironmentBots } from "../../state/bots";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import {
  type BoardDraft,
  type BoardRow,
  boardRows,
  draftInput,
  draftOf,
  linkLabel,
  NO_AREA,
} from "./botsBoard.logic";
import { useBoardEnvironmentIds } from "./useBoardEnvironmentIds";

type Translate = ReturnType<typeof useGT>;

function kindLabel(gt: Translate, kind: BotBoardKind, plural = false): string {
  switch (kind) {
    case "project":
      return plural
        ? gt("Projects", { $context: "board kind" })
        : gt("Project", { $context: "board kind" });
    case "task":
      return plural
        ? gt("To-dos", { $context: "board kind" })
        : gt("To-do", { $context: "board kind" });
    case "machine":
      return plural
        ? gt("Machines", { $context: "board kind" })
        : gt("Machine", { $context: "board kind" });
    case "service":
      return plural
        ? gt("Services", { $context: "board kind" })
        : gt("Service", { $context: "board kind" });
    case "repo":
      return plural
        ? gt("Repos", { $context: "board kind" })
        : gt("Repo", { $context: "board kind" });
    case "note":
      return plural
        ? gt("Notes", { $context: "board kind" })
        : gt("Note", { $context: "board kind" });
    case "link":
      return plural
        ? gt("Links", { $context: "board kind" })
        : gt("Link", { $context: "board kind" });
  }
}

function statusLabel(gt: Translate, status: string): string {
  const labels: Record<string, string> = {
    active: gt("Active", { $context: "board status" }),
    paused: gt("Paused", { $context: "board status" }),
    idea: gt("Idea", { $context: "board status" }),
    done: gt("Done", { $context: "board status" }),
    todo: gt("To do", { $context: "board status" }),
    doing: gt("Doing", { $context: "board status" }),
    waiting: gt("Waiting", { $context: "board status" }),
    online: gt("Online", { $context: "board status" }),
    offline: gt("Offline", { $context: "board status" }),
    unknown: gt("Unknown", { $context: "board status" }),
    running: gt("Running", { $context: "board status" }),
    stopped: gt("Stopped", { $context: "board status" }),
    failing: gt("Failing", { $context: "board status" }),
    archived: gt("Archived", { $context: "board status" }),
  };
  return labels[status] ?? status;
}

function statusVariant(status: string | undefined) {
  switch (status) {
    case "done":
    case "online":
    case "running":
    case "active":
      return "success" as const;
    case "doing":
      return "info" as const;
    case "waiting":
    case "paused":
      return "warning" as const;
    case "failing":
    case "offline":
      return "error" as const;
    default:
      return "secondary" as const;
  }
}

export function BotsBoardPage() {
  const gt = useGT();
  const environmentIds = useBoardEnvironmentIds();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId =
    [chosen, primaryEnvironmentId].find(
      (id): id is EnvironmentId => id !== null && environmentIds.includes(id),
    ) ??
    environmentIds[0] ??
    null;
  const environmentLabel = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel={gt("Projects board breadcrumb")} className="flex-1">
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
                <WorkspaceBreadcrumbText>
                  <T>Projects board</T>
                </WorkspaceBreadcrumbText>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          {environmentIds.length > 1 && environmentId !== null ? (
            <Select
              value={environmentId}
              onValueChange={(id) => {
                if (id !== null) setChosen(id);
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
        </WorkspacePageHeader>
        {environmentId === null ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayoutListIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>The Projects board is off</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>
                  Turn it on in Settings › Labs to share a board of projects and to-dos with your
                  Bots.
                </T>
              </EmptyDescription>
            </EmptyHeader>
            <Button size="sm" variant="outline" render={<Link to="/settings/labs" />}>
              <T>Open Labs</T>
            </Button>
          </Empty>
        ) : (
          <BoardView key={environmentId} environmentId={environmentId} />
        )}
      </div>
    </SidebarInset>
  );
}

type Editing = { readonly item: BotBoardItem | null; readonly kind: BotBoardKind } | null;

function BoardView({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const result = useAtomValue(serverEnvironment.botBoardLive({ environmentId, input: {} }));
  const board = AsyncResult.getOrElse(result, () => null);
  const canEdit = useAtomValue(serverEnvironment.saveBotBoard.permissionAtom(environmentId));
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const items = board?.items ?? [];
  const rows = boardRows(items, { search, showArchived });
  const openItem = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (item !== undefined) setEditing({ item, kind: item.kind });
  };
  // The open item follows live edits, and closes if a Bot deletes it.
  const current =
    editing?.item === null || editing === null
      ? null
      : (items.find((item) => item.id === editing.item?.id) ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Input
          type="search"
          aria-label={gt("Search the board")}
          placeholder={gt("Search the board")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showArchived} onCheckedChange={(checked) => setShowArchived(checked)} />
          <T>Show archived</T>
        </label>
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={!canEdit}
          onClick={() => setEditing({ item: null, kind: "task" })}
        >
          <PlusIcon />
          <T>New item</T>
        </Button>
      </div>
      {board === null ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {AsyncResult.isFailure(result) ? (
            <T>The board couldn’t be loaded.</T>
          ) : (
            <T>Loading the board…</T>
          )}
        </p>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>
              {items.length === 0 ? <T>Nothing on the board yet</T> : <T>No matches</T>}
            </EmptyTitle>
            <EmptyDescription>
              <T>
                Add projects and to-dos here, or tell a Bot about them; they keep it up to date.
              </T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-h-0 flex-1">
          <LegendList<BoardRow>
            data={rows}
            keyExtractor={(row) => row.key}
            getItemType={(row) => row.kind}
            estimatedItemSize={36}
            recycleItems
            renderItem={({ item: row }) => <BoardRowView row={row} onOpen={openItem} />}
            style={{ height: "100%" }}
          />
        </div>
      )}
      {editing !== null && (editing.item === null || current !== null) ? (
        <BoardItemSheet
          key={editing.item?.id ?? "new"}
          environmentId={environmentId}
          item={current}
          kind={editing.kind}
          items={items}
          canEdit={canEdit}
          onOpenItem={openItem}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function BoardRowView({ row, onOpen }: { row: BoardRow; onOpen: (id: string) => void }) {
  const gt = useGT();
  if (row.kind === "area") {
    return (
      <div className="flex items-center gap-2 px-4 pt-5 pb-1">
        <span className="text-sm font-semibold capitalize">
          {row.area === NO_AREA ? gt("No area", { $context: "board area" }) : row.area}
        </span>
        <span className="text-xs text-muted-foreground">{row.count}</span>
      </div>
    );
  }
  if (row.kind === "group") {
    return (
      <div className="px-4 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {kindLabel(gt, row.itemKind, true)}
      </div>
    );
  }
  const { item } = row;
  const due = item.fields.due;
  return (
    <button
      type="button"
      onClick={() => onOpen(item.id)}
      className="flex h-9 w-full cursor-pointer items-center gap-2 px-4 text-left text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {item.pinned ? (
        <PinIcon aria-label={gt("Pinned")} className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
      <span
        className={
          item.status === "done" || item.archived
            ? "min-w-0 truncate text-muted-foreground line-through"
            : "min-w-0 truncate"
        }
      >
        {item.title}
      </span>
      {row.parentTitle ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{row.parentTitle}</span>
      ) : null}
      <span className="flex-1" />
      {typeof due === "string" ? (
        <span className="shrink-0 text-xs text-muted-foreground">{due}</span>
      ) : null}
      {item.archived ? (
        <ArchiveIcon
          aria-label={gt("Archived")}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      {item.status ? (
        <Badge size="sm" variant={statusVariant(item.status)} className="shrink-0">
          {statusLabel(gt, item.status)}
        </Badge>
      ) : null}
      {item.updatedBy.type === "bot" ? (
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {item.updatedBy.name ?? item.updatedBy.slug}
        </span>
      ) : null}
    </button>
  );
}

function BoardItemSheet(props: {
  environmentId: EnvironmentId;
  item: BotBoardItem | null;
  kind: BotBoardKind;
  items: ReadonlyArray<BotBoardItem>;
  canEdit: boolean;
  onOpenItem: (id: string) => void;
  onClose: () => void;
}) {
  const { environmentId, item, canEdit } = props;
  const gt = useGT();
  const { bots } = useEnvironmentBots();
  const [draft, setDraft] = useState<BoardDraft>(() => draftOf(item, props.kind));
  const [newLink, setNewLink] = useState("");
  const [saving, setSaving] = useState(false);
  const save = useAtomCommand(serverEnvironment.saveBotBoard, {
    label: "bot board save",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteBotBoardItems, {
    label: "bot board delete",
    reportFailure: false,
  });
  const set = <K extends keyof BoardDraft>(key: K, value: BoardDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const statuses = BOT_BOARD_STATUSES[draft.kind];
  const parents = props.items.filter(
    (candidate) => candidate.kind === "project" && candidate.id !== item?.id && !candidate.archived,
  );
  const reportFailure = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? undefined,
      }),
    );

  const submit = async () => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const input = draftInput(item, draft);
    if (input === null) return props.onClose();
    setSaving(true);
    const result = await save({ environmentId, input: { items: [input] } });
    setSaving(false);
    if (result._tag === "Success") return props.onClose();
    if (!isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not save the item"), squashAtomCommandFailure(result));
    }
  };

  const destroy = async () => {
    if (item === null || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    const message = gt("Delete “{title}”? Anything inside it moves up a level.", {
      title: item.title,
    });
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await remove({ environmentId, input: { ids: [item.id] } });
    if (result._tag === "Success") return props.onClose();
    if (!isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not delete the item"), squashAtomCommandFailure(result));
    }
  };

  const addLink = () => {
    const url = newLink.trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (draft.links.some((link) => link.type === "url" && link.url === url)) return setNewLink("");
    set("links", [...draft.links, { type: "url", url }]);
    setNewLink("");
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup side="right" className="max-w-lg">
        <SheetHeader>
          <SheetTitle>{item === null ? <T>New item</T> : kindLabel(gt, item.kind)}</SheetTitle>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={!canEdit || saving} className="contents">
            <BoardField label={gt("Title")}>
              <Input
                value={draft.title}
                required
                maxLength={200}
                autoFocus={item === null}
                onChange={(event) => set("title", event.target.value)}
              />
            </BoardField>
            <div className="grid grid-cols-2 gap-3">
              <BoardField label={gt("Kind", { $context: "board item kind" })}>
                <Select
                  value={draft.kind}
                  onValueChange={(kind) => {
                    if (kind === null) return;
                    setDraft((previous) => ({
                      ...previous,
                      kind,
                      status: BOT_BOARD_STATUSES[kind].includes(previous.status)
                        ? previous.status
                        : "",
                    }));
                  }}
                >
                  <SelectTrigger size="sm">
                    <SelectValue>{kindLabel(gt, draft.kind)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {BOT_BOARD_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind} label={kindLabel(gt, kind)}>
                        {kindLabel(gt, kind)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </BoardField>
              {statuses.length > 0 ? (
                <BoardField label={gt("Status")}>
                  <Select
                    value={draft.status || statuses[0]!}
                    onValueChange={(status) => {
                      if (status !== null) set("status", status);
                    }}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue>{statusLabel(gt, draft.status || statuses[0]!)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {statuses.map((status) => (
                        <SelectItem key={status} value={status} label={statusLabel(gt, status)}>
                          {statusLabel(gt, status)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </BoardField>
              ) : null}
              <BoardField label={gt("Area", { $context: "board area" })}>
                <Input
                  value={draft.area}
                  placeholder={gt("work, personal…")}
                  maxLength={40}
                  onChange={(event) => set("area", event.target.value)}
                />
              </BoardField>
              {draft.kind !== "project" ? (
                <BoardField label={gt("Project", { $context: "board item parent" })}>
                  <Select
                    value={draft.parentId}
                    onValueChange={(parentId) => set("parentId", parentId ?? "")}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue>
                        {parents.find((parent) => parent.id === draft.parentId)?.title ??
                          gt("None", { $context: "no parent project" })}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="" label={gt("None", { $context: "no parent project" })}>
                        {gt("None", { $context: "no parent project" })}
                      </SelectItem>
                      {parents.map((parent) => (
                        <SelectItem key={parent.id} value={parent.id} label={parent.title}>
                          {parent.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </BoardField>
              ) : null}
              <BoardField label={gt("Due", { $context: "board due date" })}>
                <Input
                  type="date"
                  value={draft.due}
                  onChange={(event) => set("due", event.target.value)}
                />
              </BoardField>
              <BoardField label={gt("Priority")}>
                <Select
                  value={draft.priority || "normal"}
                  onValueChange={(priority) =>
                    set("priority", priority === "normal" ? "" : (priority ?? ""))
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue>{priorityLabel(gt, draft.priority || "normal")}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {BOT_BOARD_PRIORITIES.map((priority) => (
                      <SelectItem
                        key={priority}
                        value={priority}
                        label={priorityLabel(gt, priority)}
                      >
                        {priorityLabel(gt, priority)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </BoardField>
              <BoardField label={gt("Owner")}>
                <Input
                  value={draft.owner}
                  maxLength={60}
                  onChange={(event) => set("owner", event.target.value)}
                />
              </BoardField>
              <BoardField label={gt("Tags")}>
                <Input
                  value={draft.tags}
                  placeholder={gt("comma, separated")}
                  onChange={(event) => set("tags", event.target.value)}
                />
              </BoardField>
            </div>
            <BoardField label={gt("Address", { $context: "board item web address" })}>
              <Input
                type="url"
                value={draft.url}
                placeholder="https://"
                onChange={(event) => set("url", event.target.value)}
              />
            </BoardField>
            <BoardField label={gt("Notes")}>
              <Textarea
                rows={6}
                value={draft.body}
                maxLength={20_000}
                onChange={(event) => set("body", event.target.value)}
              />
            </BoardField>
            <BoardField label={gt("Links")}>
              <ul className="flex flex-col gap-1">
                {draft.links.map((link, index) => (
                  <li
                    key={`${link.type}:${linkLabel(link)}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <BoardLinkView
                      link={link}
                      environmentId={environmentId}
                      bots={bots}
                      onOpenItem={props.onOpenItem}
                    />
                    <span className="flex-1" />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={gt("Remove link")}
                      onClick={() =>
                        set(
                          "links",
                          draft.links.filter((_, at) => at !== index),
                        )
                      }
                    >
                      <XIcon />
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Input
                  type="url"
                  value={newLink}
                  placeholder={gt("Add a web link")}
                  onChange={(event) => setNewLink(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addLink();
                    }
                  }}
                />
                <Button size="sm" variant="outline" onClick={addLink}>
                  <T>Add</T>
                </Button>
              </div>
            </BoardField>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <Switch
                  checked={draft.pinned}
                  onCheckedChange={(checked) => set("pinned", checked)}
                />
                <T>Pinned</T>
              </label>
              {item !== null ? (
                <label className="flex items-center gap-2">
                  <Switch
                    checked={draft.archived}
                    onCheckedChange={(checked) => set("archived", checked)}
                  />
                  <T>Archived</T>
                </label>
              ) : null}
            </div>
            {item !== null ? (
              <p className="text-xs text-muted-foreground">
                {item.updatedBy.type === "bot"
                  ? gt("Last changed by {name}", {
                      name: item.updatedBy.name ?? item.updatedBy.slug ?? gt("a Bot"),
                    })
                  : gt("Last changed by you")}
              </p>
            ) : null}
            <div className="flex items-center gap-2 pt-2">
              {item !== null ? (
                <Button variant="destructive-outline" size="sm" onClick={() => void destroy()}>
                  <T>Delete</T>
                </Button>
              ) : null}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={props.onClose}>
                <T>Cancel</T>
              </Button>
              <Button type="submit" size="sm" disabled={draft.title.trim() === ""}>
                {item === null ? <T>Add</T> : <T>Save</T>}
              </Button>
            </div>
          </fieldset>
        </form>
      </SheetPopup>
    </Sheet>
  );
}

function priorityLabel(gt: Translate, priority: string) {
  return priority === "high"
    ? gt("High", { $context: "priority" })
    : priority === "low"
      ? gt("Low", { $context: "priority" })
      : gt("Normal", { $context: "priority" });
}

function BoardField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function BoardLinkView(props: {
  link: BotBoardLink;
  environmentId: EnvironmentId;
  bots: ReturnType<typeof useEnvironmentBots>["bots"];
  onOpenItem: (id: string) => void;
}) {
  const { link } = props;
  const label = linkLabel(link);
  const className = "min-w-0 truncate text-sm underline-offset-2 hover:underline";
  switch (link.type) {
    case "url":
      return (
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className={`${className} inline-flex items-center gap-1`}
        >
          <ExternalLinkIcon className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
        </a>
      );
    case "thread":
      return (
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(
            scopeThreadRef(
              (link.environmentId as EnvironmentId | undefined) ?? props.environmentId,
              ThreadId.make(link.threadId),
            ),
          )}
          className={className}
        >
          {label}
        </Link>
      );
    case "bot": {
      const bot = props.bots.find(
        (entry) => entry.environmentId === props.environmentId && entry.bot.slug === link.slug,
      );
      return bot === undefined ? (
        <span className={className}>{label}</span>
      ) : (
        <Link to="/bots/$botId" params={{ botId: bot.bot.id }} className={className}>
          {link.label ?? bot.bot.name}
        </Link>
      );
    }
    case "item":
      return (
        <button
          type="button"
          className={`${className} cursor-pointer`}
          onClick={() => props.onOpenItem(link.id)}
        >
          {label}
        </button>
      );
  }
}
