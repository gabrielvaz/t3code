import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  BOT_VAULT_FIELD_MAX_CHARS,
  type BotVaultContact,
  type BotVaultListItem,
  type BotVaultLoginSummary,
  type BotVaultUpsertInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import {
  ContactIcon,
  EyeIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { m } from "../../i18n/messages";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSearchableSetting } from "../settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotField } from "./BotField";
import { parseVaultCsv } from "./vaultCsv";

type Editing =
  | { readonly kind: "login"; readonly item: BotVaultLoginSummary | null }
  | { readonly kind: "contact"; readonly item: BotVaultContact | null };

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function itemTitle(item: BotVaultListItem): string {
  if (item.kind === "login") return item.title;
  return item.label || item.name || item.emails[0] || item.phones[0] || item.street;
}

function itemDetail(item: BotVaultListItem): string {
  if (item.kind === "login") {
    return [item.username, ...item.websites.map((site) => site.replace(/^https?:\/\//, ""))]
      .filter(Boolean)
      .join(" · ");
  }
  return [item.name, item.emails[0], item.city].filter(Boolean).join(" · ");
}

export function BotVaultSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const messages = useMessages();
  const setting = useSearchableSetting();
  const query = useEnvironmentQuery(
    serverEnvironment.botVault({ environmentId, input: {} }),
    messages,
  );
  const canEdit = useAtomValue(serverEnvironment.upsertBotVaultItem.permissionAtom(environmentId));
  const deleteItem = useAtomCommand(serverEnvironment.deleteBotVaultItem, {
    label: "bot vault delete",
    reportFailure: false,
  });
  const importCsv = useAtomCommand(serverEnvironment.importBotVaultCsv, {
    label: "bot vault import",
    reportFailure: false,
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const items = (query.data?.items ?? []).filter(
    (item): item is BotVaultListItem => item !== undefined,
  );
  const logins = items.filter((item) => item.kind === "login");
  const contacts = items.filter((item) => item.kind === "contact");

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
      }),
    );
  };

  const confirmDelete = async (item: BotVaultListItem) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const message = gt("Delete {name} from the Vault? Bots can no longer use it.", {
      name: itemTitle(item),
    });
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await deleteItem({ environmentId, input: { id: item.id } });
    if (result._tag === "Success") query.refresh();
    else reportFailure(gt("Could not delete {name}", { name: itemTitle(item) }), result);
  };

  const importFile = async (file: File) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const parsed = parseVaultCsv(await file.text());
    if (parsed.items.length === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Nothing to import"),
          description: gt("No logins or contact info were found in {file}.", { file: file.name }),
        }),
      );
      return;
    }
    const message = gt("Import {count} items from this {format} export into the Vault?", {
      count: parsed.items.length,
      format: parsed.format,
    });
    const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await importCsv({ environmentId, input: { items: parsed.items } });
    if (result._tag === "Failure") {
      reportFailure(gt("Could not import {file}", { file: file.name }), result);
      return;
    }
    query.refresh();
    const { added, updated, skipped } = result.value;
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Imported {file}", { file: file.name }),
        description: gt("{added} added, {updated} updated, {skipped} skipped.", {
          added,
          updated,
          skipped: skipped + parsed.skipped,
        }),
      }),
    );
  };

  const row = (item: BotVaultListItem) => (
    <SettingsRow
      key={item.id}
      title={itemTitle(item)}
      description={itemDetail(item)}
      control={
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Edit {name}", { name: itemTitle(item) })}
            disabled={!canEdit}
            onClick={() =>
              setEditing(
                item.kind === "login" ? { kind: "login", item } : { kind: "contact", item },
              )
            }
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Delete {name}", { name: itemTitle(item) })}
            disabled={!canEdit}
            onClick={() => void confirmDelete(item)}
          >
            <Trash2Icon />
          </Button>
        </div>
      }
    />
  );

  return (
    <SettingsSection
      {...setting("bots-vault")}
      headerAction={
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canEdit}
            onClick={() => fileInput.current?.click()}
          >
            <UploadIcon className="size-3" />
            <T>Import CSV</T>
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canEdit}
            onClick={() => setEditing({ kind: "contact", item: null })}
          >
            <ContactIcon className="size-3" />
            <T>Add contact</T>
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canEdit}
            onClick={() => setEditing({ kind: "login", item: null })}
          >
            <PlusIcon className="size-3" />
            <T>Add login</T>
          </Button>
        </div>
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      {query.error !== null && query.data === null ? (
        <SettingsRow title={gt("Could not open the Vault")} description={query.error} />
      ) : items.length === 0 ? (
        <SettingsRow
          title={gt("The Vault is empty")}
          description={gt(
            "Logins, API tokens and contact info your Bots may use. Bots fill passwords into pages without seeing them; import a CSV from 1Password, Chrome, Safari, Firefox, Bitwarden or LastPass to start.",
          )}
        />
      ) : (
        <>
          {logins.map(row)}
          {contacts.map(row)}
        </>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      >
        <DialogPopup className="max-w-lg">
          {editing?.kind === "login" ? (
            <VaultLoginForm
              environmentId={environmentId}
              item={editing.item}
              onDone={(saved) => {
                setEditing(null);
                if (saved) query.refresh();
              }}
            />
          ) : editing?.kind === "contact" ? (
            <VaultContactForm
              environmentId={environmentId}
              item={editing.item}
              onDone={(saved) => {
                setEditing(null);
                if (saved) query.refresh();
              }}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

function useVaultSave(environmentId: EnvironmentId) {
  const gt = useGT();
  const upsert = useAtomCommand(serverEnvironment.upsertBotVaultItem, {
    label: "bot vault upsert",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const save = async (input: BotVaultUpsertInput): Promise<boolean> => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not save to the Vault"),
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        }),
      );
    }
    return false;
  };
  return { save, saving };
}

function VaultLoginForm({
  environmentId,
  item,
  onDone,
}: {
  environmentId: EnvironmentId;
  item: BotVaultLoginSummary | null;
  onDone: (saved: boolean) => void;
}) {
  const gt = useGT();
  const { save, saving } = useVaultSave(environmentId);
  const canReveal = useAtomValue(
    serverEnvironment.revealBotVaultPassword.permissionAtom(environmentId),
  );
  const reveal = useAtomCommand(serverEnvironment.revealBotVaultPassword, {
    label: "bot vault reveal",
    reportFailure: false,
  });
  const [title, setTitle] = useState(item?.title ?? "");
  const [websites, setWebsites] = useState(item?.websites.join("\n") ?? "");
  const [username, setUsername] = useState(item?.username ?? "");
  const [password, setPassword] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [hints, setHints] = useState(item?.hints ?? "");
  const [botCanRead, setBotCanRead] = useState(item?.botCanRead ?? false);
  const sites = lines(websites);
  const valid = title.trim() !== "" || sites.length > 0;

  const showPassword = async () => {
    if (item === null || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const result = await reveal({ environmentId, input: { id: item.id } });
    if (result._tag === "Success") {
      setPassword(result.value.password);
      setRevealed(true);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not show the password"),
          description: thrownErrorMessage(squashAtomCommandFailure(result), m) ?? undefined,
        }),
      );
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !valid) return;
    const saved = await save({
      kind: "login",
      ...(item === null ? {} : { id: item.id }),
      title: title.trim(),
      websites: sites,
      username: username.trim(),
      hints: hints.trim(),
      botCanRead,
      ...(password === null ? {} : { password }),
    });
    if (saved) onDone(true);
  };

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>{item === null ? <T>Add login</T> : <T>Edit login</T>}</DialogTitle>
        <DialogDescription>
          <T>
            Bots type this password into its sites for you and never see it, unless you let them
            read it as an API token.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          <BotField label={gt("Websites")} hint={gt("One per line")} htmlFor="vault-websites">
            <Textarea
              id="vault-websites"
              rows={2}
              autoFocus={item === null}
              placeholder="https://github.com"
              value={websites}
              onChange={(event) => setWebsites(event.target.value)}
            />
          </BotField>
          <BotField label={gt("Title")} hint={gt("Optional")} htmlFor="vault-title">
            <Input
              id="vault-title"
              maxLength={BOT_VAULT_FIELD_MAX_CHARS}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </BotField>
          <BotField label={gt("Username or email")} htmlFor="vault-username">
            <Input
              id="vault-username"
              autoComplete="off"
              maxLength={BOT_VAULT_FIELD_MAX_CHARS}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </BotField>
          <BotField
            label={gt("Password or token")}
            hint={item?.hasPassword && password === null ? gt("Leave empty to keep it") : undefined}
            htmlFor="vault-password"
          >
            <div className="flex items-center gap-2">
              <Input
                id="vault-password"
                type={revealed ? "text" : "password"}
                autoComplete="new-password"
                maxLength={BOT_VAULT_FIELD_MAX_CHARS}
                value={password ?? ""}
                placeholder={item?.hasPassword ? "••••••••" : undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
              {item?.hasPassword && !revealed ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canReveal}
                  onClick={() => void showPassword()}
                >
                  <EyeIcon />
                  <T>Show</T>
                </Button>
              ) : null}
            </div>
          </BotField>
          <BotField label={gt("Hints")} hint={gt("When to use it")} htmlFor="vault-hints">
            <Input
              id="vault-hints"
              maxLength={BOT_VAULT_FIELD_MAX_CHARS}
              value={hints}
              onChange={(event) => setHints(event.target.value)}
            />
          </BotField>
          <label className="flex items-start justify-between gap-4 text-sm">
            <span>
              <span className="flex items-center gap-1.5 font-medium">
                <KeyRoundIcon className="size-3.5" />
                <T>Bots can read this</T>
              </span>
              <span className="block text-xs text-muted-foreground">
                <T>For API tokens and keys a Bot must send itself. Leave off for passwords.</T>
              </span>
            </span>
            <Switch checked={botCanRead} onCheckedChange={setBotCanRead} />
          </label>
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          <T>Cancel</T>
        </DialogClose>
        <Button type="submit" size="sm" disabled={saving || !valid}>
          <T>Save</T>
        </Button>
      </DialogFooter>
    </form>
  );
}

function VaultContactForm({
  environmentId,
  item,
  onDone,
}: {
  environmentId: EnvironmentId;
  item: BotVaultContact | null;
  onDone: (saved: boolean) => void;
}) {
  const gt = useGT();
  const { save, saving } = useVaultSave(environmentId);
  const [fields, setFields] = useState({
    label: item?.label ?? "",
    name: item?.name ?? "",
    emails: item?.emails.join("\n") ?? "",
    phones: item?.phones.join("\n") ?? "",
    street: item?.street ?? "",
    apt: item?.apt ?? "",
    city: item?.city ?? "",
    state: item?.state ?? "",
    zip: item?.zip ?? "",
    country: item?.country ?? "",
  });
  const set = (field: keyof typeof fields) => (value: string) =>
    setFields((current) => ({ ...current, [field]: value }));
  const valid =
    fields.label.trim() !== "" ||
    fields.name.trim() !== "" ||
    lines(fields.emails).length > 0 ||
    lines(fields.phones).length > 0 ||
    fields.street.trim() !== "";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !valid) return;
    const saved = await save({
      kind: "contact",
      ...(item === null ? {} : { id: item.id }),
      label: fields.label.trim(),
      name: fields.name.trim(),
      emails: lines(fields.emails),
      phones: lines(fields.phones),
      street: fields.street.trim(),
      apt: fields.apt.trim(),
      city: fields.city.trim(),
      state: fields.state.trim(),
      zip: fields.zip.trim(),
      country: fields.country.trim(),
    });
    if (saved) onDone(true);
  };

  const text = (field: keyof typeof fields, label: string) => (
    <BotField label={label} htmlFor={`vault-contact-${field}`}>
      <Input
        id={`vault-contact-${field}`}
        maxLength={BOT_VAULT_FIELD_MAX_CHARS}
        value={fields[field]}
        onChange={(event) => set(field)(event.target.value)}
      />
    </BotField>
  );

  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>
          {item === null ? <T>Add contact info</T> : <T>Edit contact info</T>}
        </DialogTitle>
        <DialogDescription>
          <T>Your Bots type these details into forms for you.</T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="grid min-w-0 gap-4 sm:grid-cols-2">
          {text("label", gt("Label, such as Home or Work"))}
          {text("name", gt("Full name"))}
          <BotField label={gt("Emails")} hint={gt("One per line")} htmlFor="vault-contact-emails">
            <Textarea
              id="vault-contact-emails"
              rows={2}
              value={fields.emails}
              onChange={(event) => set("emails")(event.target.value)}
            />
          </BotField>
          <BotField label={gt("Phones")} hint={gt("One per line")} htmlFor="vault-contact-phones">
            <Textarea
              id="vault-contact-phones"
              rows={2}
              value={fields.phones}
              onChange={(event) => set("phones")(event.target.value)}
            />
          </BotField>
          {text("street", gt("Street"))}
          {text("apt", gt("Apartment, suite"))}
          {text("city", gt("City"))}
          {text("state", gt("State or region"))}
          {text("zip", gt("Postal code"))}
          {text("country", gt("Country"))}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          <T>Cancel</T>
        </DialogClose>
        <Button type="submit" size="sm" disabled={saving || !valid}>
          <T>Save</T>
        </Button>
      </DialogFooter>
    </form>
  );
}
