import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PencilIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { m } from "../../i18n/messages";
import ChatMarkdown from "../ChatMarkdown";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { isBotConflictError } from "./bots.logic";

interface TextFile {
  readonly text: string;
  readonly revision: string;
}

type Draft = TextFile;

/**
 * A Markdown file the Bot or its user may change at any time. Saves send the revision the
 * draft started from; a conflict keeps the draft and offers the file's current text.
 */
export function BotTextFileEditor({
  label,
  file,
  loadedAt,
  error,
  mode,
  environmentId,
  cwd,
  maxLength,
  canEdit,
  emptyText,
  placeholder,
  onSave,
  onReload,
}: {
  label: string;
  file: TextFile | null;
  /** When the query last answered; a newer answer replaces the copy kept after a save. */
  loadedAt: number;
  error: string | null;
  /** `edit` is always a text box; `view` renders Markdown until the user edits. */
  mode: "edit" | "view";
  environmentId: EnvironmentId;
  cwd: string | undefined;
  maxLength: number;
  canEdit: boolean;
  emptyText: string;
  placeholder?: string;
  onSave: (text: string, expectedRevision: string) => Promise<AtomCommandResult<unknown, unknown>>;
  onReload: () => void;
}) {
  const gt = useGT();
  const [saved, setSaved] = useState<{ file: TextFile; at: number } | null>(null);
  if (saved !== null && loadedAt >= saved.at) setSaved(null);
  const current = saved?.file ?? file;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingInView, setEditingInView] = useState(false);
  const [conflict, setConflict] = useState<TextFile | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = mode === "edit" || editingInView;
  const text = draft?.text ?? current?.text ?? "";
  const dirty = draft !== null && current !== null && draft.text !== current.text;

  const save = async (expectedRevision: string) => {
    if (saving || !canEdit || current === null) return;
    const textToSave = draft?.text ?? current.text;
    setSaving(true);
    const result = await onSave(textToSave, expectedRevision);
    setSaving(false);
    if (result._tag === "Success") {
      const revision = (result.value as { readonly revision?: unknown }).revision;
      setSaved({
        file: { text: textToSave, revision: typeof revision === "string" ? revision : "" },
        at: Date.now(),
      });
      setDraft(null);
      setConflict(null);
      setEditingInView(false);
      onReload();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    if (isBotConflictError(failure)) {
      setConflict({ text: failure.currentText, revision: failure.revision });
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: gt("Could not save {file}", { file: label }),
        description: thrownErrorMessage(failure, m) ?? undefined,
      }),
    );
  };

  const loadCurrent = () => {
    if (conflict === null) return;
    setSaved({ file: conflict, at: Date.now() });
    setDraft(null);
    setConflict(null);
    onReload();
  };

  const cancel = () => {
    setDraft(null);
    setConflict(null);
    setEditingInView(false);
  };

  if (current === null) {
    return error !== null ? (
      <p className="text-sm text-destructive" role="status">
        {error}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground" role="status">
        <T>Loading…</T>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {conflict !== null ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>
            <T>This changed since you opened it</T>
          </AlertTitle>
          <AlertDescription>
            <T>
              Your edits are still here. Load the current version to start again from it, or
              overwrite it with yours.
            </T>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-background/60 p-2 text-xs whitespace-pre-wrap text-foreground">
              {conflict.text || gt("(empty)")}
            </pre>
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={loadCurrent}>
              <T>Load current version</T>
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canEdit || saving}
              onClick={() => void save(conflict.revision)}
            >
              <T>Overwrite with mine</T>
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {editing ? (
        <Textarea
          aria-label={label}
          value={text}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={!canEdit || saving}
          rows={12}
          onChange={(event) =>
            setDraft({ text: event.target.value, revision: draft?.revision ?? current.revision })
          }
        />
      ) : current.text.trim().length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </p>
      ) : (
        <div className="rounded-lg border px-4 py-3">
          <ChatMarkdown text={current.text} cwd={cwd} environmentId={environmentId} />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {error !== null ? (
          <span className="me-auto text-xs text-destructive" role="status">
            {error}
          </span>
        ) : null}
        <Button size="xs" variant="ghost-muted" disabled={saving} onClick={onReload}>
          <RefreshCwIcon />
          <T>Reload</T>
        </Button>
        {editing ? (
          <>
            {mode === "view" || dirty ? (
              <Button size="xs" variant="outline" disabled={saving} onClick={cancel}>
                <T>Cancel</T>
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={!canEdit || saving || (!dirty && mode === "edit")}
              onClick={() => void save(draft?.revision ?? current.revision)}
            >
              <T>Save</T>
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={!canEdit}
            onClick={() => setEditingInView(true)}
          >
            <PencilIcon />
            <T>Edit</T>
          </Button>
        )}
      </div>
    </div>
  );
}
