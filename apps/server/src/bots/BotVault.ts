// Adapted from Threebot server/vault.mts and server/vault-mcp.mts (MIT, Copyright (c) 2026
// Threebot contributors).
//
// The Vault: logins, API tokens and contact info every Bot shares, encrypted at rest in
// `<botsRoot>/.shared/vault.enc`. The key lives in the server's secret store, never beside the file.
// Passwords leave this module only through `reveal` (a user with settings scope), `login` (the
// Bot tools, which type them into a page or a private file) and nowhere else.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- AES-256-GCM with AAD has no Effect counterpart
import * as NodeCrypto from "node:crypto";

import {
  BOT_VAULT_FIELD_MAX_CHARS,
  BOT_VAULT_LIST_MAX,
  BOT_VAULT_MAX_ITEMS,
  type BotVaultContact,
  type BotVaultContactInput,
  type BotVaultDeleteResult,
  BotVaultError,
  type BotVaultImportCsvResult,
  type BotVaultImportItem,
  BotVaultItemId,
  type BotVaultListItem,
  type BotVaultListResult,
  type BotVaultLoginInput,
  type BotVaultLoginSummary,
  type BotVaultUpsertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

const FORMAT = "t3-bots-vault";
const VERSION = 1;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`);
export const BOT_VAULT_KEY_NAME = "bots-vault-key";
const SECRET_FILE_TTL = Duration.hours(1);
const MAX_SECRET_FILE_BYTES = 16 * 1024;

/** A login as stored, with its password. */
export interface StoredLogin extends Omit<BotVaultLoginSummary, "hasPassword"> {
  readonly password: string;
}
type StoredItem = StoredLogin | BotVaultContact;

interface VaultEnvelope {
  readonly format: string;
  readonly version: number;
  readonly cipher: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export function encryptVault(key: Uint8Array, items: ReadonlyArray<StoredItem>): string {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify({ items }), "utf8")),
    cipher.final(),
  ]);
  const envelope: VaultEnvelope = {
    format: FORMAT,
    version: VERSION,
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return `${JSON.stringify(envelope)}\n`;
}

/** The stored items, or why they can't be read; never echoes the key or any plaintext. */
export function decryptVault(key: Uint8Array, text: string): ReadonlyArray<StoredItem> | string {
  let envelope: Partial<VaultEnvelope>;
  try {
    envelope = JSON.parse(text) as Partial<VaultEnvelope>;
  } catch {
    return "The vault file is damaged.";
  }
  if (envelope.format !== FORMAT) return "This file is not a Bots vault.";
  if (envelope.version !== VERSION || envelope.cipher !== "aes-256-gcm") {
    return `Unsupported vault version ${String(envelope.version)}.`;
  }
  try {
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv ?? "", "base64"),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag ?? "", "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data ?? "", "base64")),
      decipher.final(),
    ]);
    const payload = JSON.parse(plain.toString("utf8")) as { items?: unknown };
    return Array.isArray(payload.items) ? (payload.items as StoredItem[]) : [];
  } catch {
    return "Couldn't decrypt the vault: its key doesn't match the vault file, or the file is damaged.";
  }
}

/** "https://www.GitHub.com/login" or "github.com" → URL, or null. */
function parseSite(input: string): URL | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** The domain a login fills on: the website's hostname without a leading "www.". */
export function siteDomain(website: string): string {
  const url = parseSite(website);
  return url
    ? url.hostname
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "")
    : "";
}

/**
 * Whether a page URL is the login's saved site or one of its subdomains. Lookalikes
 * (paypal.com.evil.io, xpaypal.com, paypal-login.com) never match, and a plain-http page matches
 * only a login saved with an explicit http:// address.
 */
export function matchesSite(pageUrl: string, website: string): boolean {
  const domain = siteDomain(website);
  if (!domain) return false;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (page.protocol !== "https:" && page.protocol !== "http:") return false;
  if (page.protocol === "http:" && !/^http:\/\//i.test(website.trim())) return false;
  const host = page.hostname.toLowerCase().replace(/\.$/, "");
  return host === domain || host.endsWith(`.${domain}`);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const clean = (value: string | undefined) =>
  (value ?? "").slice(0, BOT_VAULT_FIELD_MAX_CHARS).trim();

function normalizeWebsite(value: string): string {
  const text = clean(value);
  if (!text || parseSite(text) === null) return text;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}

const uniqueList = (values: ReadonlyArray<string>, normalize: (value: string) => string) => [
  ...new Set(values.map(normalize).filter(Boolean)),
];

const invalid = (detail: string) => new BotVaultError({ reason: "invalid", detail });

export function summarize(item: StoredItem): BotVaultListItem {
  if (item.kind === "contact") return item;
  const { password, ...rest } = item;
  return { ...rest, hasPassword: password.length > 0 };
}

function buildLogin(
  input: Omit<BotVaultLoginInput, "kind" | "id">,
  base: { readonly id: BotVaultItemId; readonly createdAt: string; readonly now: string },
  existing?: StoredLogin,
): StoredLogin | string {
  const websites =
    input.websites === undefined
      ? (existing?.websites ?? [])
      : uniqueList(input.websites, normalizeWebsite).slice(0, BOT_VAULT_LIST_MAX);
  const title = input.title === undefined ? (existing?.title ?? "") : clean(input.title);
  const firstSite = websites[0] ?? "";
  if (!title && !firstSite) return "A login needs a website or a title.";
  return {
    kind: "login",
    id: base.id,
    title: title || siteDomain(firstSite) || firstSite,
    websites,
    username: input.username === undefined ? (existing?.username ?? "") : clean(input.username),
    password:
      input.password === undefined
        ? (existing?.password ?? "")
        : input.password.slice(0, BOT_VAULT_FIELD_MAX_CHARS),
    hints: input.hints === undefined ? (existing?.hints ?? "") : clean(input.hints),
    botCanRead: input.botCanRead ?? existing?.botCanRead ?? false,
    createdAt: base.createdAt,
    updatedAt: base.now,
  };
}

function buildContact(
  input: Omit<BotVaultContactInput, "kind" | "id">,
  base: { readonly id: BotVaultItemId; readonly createdAt: string; readonly now: string },
  existing?: BotVaultContact,
): BotVaultContact | string {
  const text = (
    field: "label" | "name" | "street" | "apt" | "city" | "state" | "zip" | "country",
  ) => (input[field] === undefined ? (existing?.[field] ?? "") : clean(input[field]));
  const list = (field: "emails" | "phones") => {
    const values = input[field];
    return values === undefined
      ? (existing?.[field] ?? [])
      : uniqueList(values, clean).slice(0, BOT_VAULT_LIST_MAX);
  };
  const contact: BotVaultContact = {
    kind: "contact",
    id: base.id,
    label: text("label"),
    name: text("name"),
    emails: list("emails"),
    phones: list("phones"),
    street: text("street"),
    apt: text("apt"),
    city: text("city"),
    state: text("state"),
    zip: text("zip"),
    country: text("country"),
    createdAt: base.createdAt,
    updatedAt: base.now,
  };
  if (
    !contact.label &&
    !contact.name &&
    contact.emails.length === 0 &&
    contact.phones.length === 0 &&
    !contact.street
  ) {
    return "Contact info needs at least a label, name, email, phone or street.";
  }
  return contact;
}

function buildItem(
  input: BotVaultUpsertInput | BotVaultImportItem,
  base: { readonly id: BotVaultItemId; readonly createdAt: string; readonly now: string },
  existing?: StoredItem,
): StoredItem | string {
  if (input.kind === "login") {
    const { kind: _kind, ...fields } = input;
    return buildLogin(fields, base, existing?.kind === "login" ? existing : undefined);
  }
  const { kind: _kind, ...fields } = input;
  return buildContact(fields, base, existing?.kind === "contact" ? existing : undefined);
}

/** Same site and username: a save or import updates it instead of adding a duplicate. */
function sameLoginIndex(items: ReadonlyArray<StoredItem>, login: StoredLogin): number {
  const domains = new Set(login.websites.map(siteDomain).filter(Boolean));
  return items.findIndex(
    (item) =>
      item.kind === "login" &&
      item.id !== login.id &&
      item.username === login.username &&
      (domains.size > 0
        ? item.websites.some((site) => domains.has(siteDomain(site)))
        : item.websites.length === 0 && item.title === login.title),
  );
}

const sameContact = (a: BotVaultContact, b: BotVaultContact) =>
  JSON.stringify({ ...a, id: "", createdAt: "", updatedAt: "" }) ===
  JSON.stringify({ ...b, id: "", createdAt: "", updatedAt: "" });

export interface SaveLoginFromFileInput {
  readonly website: string;
  readonly secretFile: string;
  readonly username?: string | undefined;
  readonly title?: string | undefined;
  readonly hints?: string | undefined;
  readonly apiToken?: boolean | undefined;
}

export class BotVault extends Context.Service<
  BotVault,
  {
    readonly list: Effect.Effect<BotVaultListResult, BotVaultError>;
    readonly upsert: (
      input: BotVaultUpsertInput,
    ) => Effect.Effect<{ readonly item: BotVaultListItem }, BotVaultError>;
    readonly delete: (id: BotVaultItemId) => Effect.Effect<BotVaultDeleteResult, BotVaultError>;
    readonly reveal: (id: BotVaultItemId) => Effect.Effect<string, BotVaultError>;
    readonly importItems: (
      items: ReadonlyArray<BotVaultImportItem>,
    ) => Effect.Effect<BotVaultImportCsvResult, BotVaultError>;
    /** The full login, password included, for the Bot tools only. */
    readonly login: (id: string) => Effect.Effect<StoredLogin, BotVaultError>;
    /**
     * Moves a value `request_secret` wrote with delivery "file" into the Vault, then deletes the
     * file. Only files in T3's own secret-file folder are accepted.
     */
    readonly saveLoginFromSecretFile: (
      input: SaveLoginFromFileInput,
    ) => Effect.Effect<
      { readonly item: BotVaultLoginSummary; readonly updated: boolean },
      BotVaultError
    >;
    /** Writes a readable token to an owner-only file that is deleted after an hour. */
    readonly writeSecretFile: (
      login: StoredLogin,
    ) => Effect.Effect<{ readonly file: string; readonly expiresInMinutes: number }, BotVaultError>;
  }
>()("t3/bots/BotVault") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const layerScope = yield* Effect.scope;

  const sharedDir = path.join(config.stateDir, "bots", ".shared");
  const vaultFile = path.join(sharedDir, "vault.enc");
  const secretFilesDir = path.join(sharedDir, "bot-secrets");
  // SecretRequests writes request_secret's "file" deliveries beside the secret store.
  const requestSecretFilesDir =
    secrets.directory === undefined ? undefined : path.join(secrets.directory, "files");
  const lock = yield* Semaphore.make(1);

  const storage = (detail: string) => () => new BotVaultError({ reason: "storage", detail });
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = random.uuidV4().pipe(
    Effect.map((uuid) => BotVaultItemId.make(uuid)),
    Effect.mapError(storage("Couldn't make an id.")),
  );

  const readVaultText = fileSystem.readFileString(vaultFile).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.mapError(storage("Couldn't read the vault file.")),
  );

  const readKey = secrets
    .get(BOT_VAULT_KEY_NAME)
    .pipe(Effect.mapError(storage("Couldn't read the vault key.")));

  const load = Effect.gen(function* () {
    const text = yield* readVaultText;
    if (Option.isNone(text)) return [] as ReadonlyArray<StoredItem>;
    const key = yield* readKey;
    if (Option.isNone(key)) {
      return yield* new BotVaultError({
        reason: "locked",
        detail: "The vault key is missing from the server's secret store, so the vault can't open.",
      });
    }
    const items = decryptVault(key.value, text.value);
    if (typeof items === "string") {
      return yield* new BotVaultError({ reason: "damaged", detail: items });
    }
    return items;
  });

  // A new key is made only for a new vault; an existing vault without its key stays locked.
  const keyForWrite = Effect.gen(function* () {
    const existing = yield* readKey;
    if (Option.isSome(existing)) return existing.value;
    if (Option.isSome(yield* readVaultText)) {
      return yield* new BotVaultError({
        reason: "locked",
        detail: "The vault key is missing from the server's secret store, so the vault can't open.",
      });
    }
    const key = new Uint8Array(NodeCrypto.randomBytes(32));
    yield* secrets.create(BOT_VAULT_KEY_NAME, key).pipe(
      Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
      Effect.mapError(storage("Couldn't save the vault key.")),
    );
    // Another writer may have won the create race.
    const saved = yield* readKey;
    return Option.getOrElse(saved, () => key);
  });

  const save = Effect.fn("BotVault.save")(function* (items: ReadonlyArray<StoredItem>) {
    if (items.length > BOT_VAULT_MAX_ITEMS) {
      return yield* invalid(`The vault holds at most ${BOT_VAULT_MAX_ITEMS} items.`);
    }
    const key = yield* keyForWrite;
    const text = encryptVault(key, items);
    const temp = `${vaultFile}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
    yield* fileSystem.makeDirectory(sharedDir, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(temp, text, { mode: 0o600 })),
      Effect.andThen(fileSystem.rename(temp, vaultFile)),
      Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(storage("Couldn't write the vault file.")),
    );
  });

  /** Runs `fn` on the current items under the lock and saves what it returns. */
  const mutate = <A>(
    fn: (
      items: Array<StoredItem>,
    ) => Effect.Effect<
      { readonly next: ReadonlyArray<StoredItem>; readonly result: A },
      BotVaultError
    >,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* load;
        const { next, result } = yield* fn([...current]);
        yield* save(next);
        return result;
      }),
    );

  const notFound = new BotVaultError({ reason: "not-found", detail: "No Vault item has that id." });

  const list: BotVault["Service"]["list"] = load.pipe(
    Effect.map((items) => ({ items: items.map(summarize) })),
    Effect.withSpan("BotVault.list"),
  );

  const upsert: BotVault["Service"]["upsert"] = Effect.fn("BotVault.upsert")(function* (input) {
    const now = yield* nowIso;
    const id = input.id ?? (yield* newId);
    return yield* mutate((items) =>
      Effect.gen(function* () {
        const index = input.id === undefined ? -1 : items.findIndex((item) => item.id === input.id);
        const existing = index === -1 ? undefined : items[index];
        if (input.id !== undefined && existing === undefined) return yield* notFound;
        if (existing !== undefined && existing.kind !== input.kind) {
          return yield* invalid("An item can't change between a login and contact info.");
        }
        const base = { id, createdAt: existing?.createdAt ?? now, now };
        const item = buildItem(input, base, existing);
        if (typeof item === "string") return yield* invalid(item);
        if (index === -1) items.push(item);
        else items[index] = item;
        return { next: items, result: { item: summarize(item) } };
      }),
    );
  });

  const deleteItem: BotVault["Service"]["delete"] = Effect.fn("BotVault.delete")(function* (id) {
    return yield* mutate((items) => {
      const next = items.filter((item) => item.id !== id);
      return next.length === items.length
        ? Effect.fail(notFound)
        : Effect.succeed({ next, result: { id } });
    });
  });

  const login: BotVault["Service"]["login"] = Effect.fn("BotVault.login")(function* (id) {
    const item = (yield* load).find((entry) => entry.id === id);
    if (item === undefined || item.kind !== "login") {
      return yield* new BotVaultError({
        reason: "not-found",
        detail: "No login has that id. Check vault_list.",
      });
    }
    return item;
  });

  const reveal: BotVault["Service"]["reveal"] = (id) =>
    login(id).pipe(
      Effect.map((item) => item.password),
      Effect.withSpan("BotVault.reveal"),
    );

  const importItems: BotVault["Service"]["importItems"] = Effect.fn("BotVault.importItems")(
    function* (rows) {
      const now = yield* nowIso;
      const ids = yield* Effect.forEach(rows, () => newId);
      return yield* mutate((items) =>
        Effect.sync(() => {
          let added = 0;
          let updated = 0;
          let skipped = 0;
          rows.forEach((row, index) => {
            const item = buildItem(row, { id: ids[index]!, createdAt: now, now });
            if (typeof item === "string") {
              skipped++;
              return;
            }
            if (item.kind === "contact") {
              if (items.some((entry) => entry.kind === "contact" && sameContact(entry, item))) {
                skipped++;
                return;
              }
              items.push(item);
              added++;
              return;
            }
            const same = sameLoginIndex(items, item);
            const previous = same === -1 ? undefined : items[same];
            if (previous === undefined || previous.kind !== "login") {
              items.push(item);
              added++;
              return;
            }
            if (
              previous.password === item.password &&
              (!item.hints || previous.hints === item.hints)
            ) {
              skipped++;
              return;
            }
            items[same] = {
              ...previous,
              password: item.password || previous.password,
              hints: item.hints || previous.hints,
              updatedAt: now,
            };
            updated++;
          });
          return { next: items, result: { added, updated, skipped } };
        }),
      );
    },
  );

  /** The value of a file request_secret wrote; any other path is refused. */
  const readRequestSecretFile = Effect.fn("BotVault.readRequestSecretFile")(function* (
    file: string,
  ) {
    if (requestSecretFilesDir === undefined) {
      return yield* invalid("Saving secrets isn't set up on this server.");
    }
    const expired = invalid(
      'That secret file doesn\'t exist; it may have expired. Ask again with request_secret, delivery "file".',
    );
    const [real, root] = yield* Effect.all([
      fileSystem.realPath(file),
      fileSystem.realPath(requestSecretFilesDir),
    ]).pipe(Effect.mapError(() => expired));
    if (path.dirname(real) !== root) {
      return yield* invalid("secretFile must be the file request_secret returned.");
    }
    const info = yield* fileSystem.stat(real).pipe(Effect.mapError(() => expired));
    if (info.type !== "File" || Number(info.size) > MAX_SECRET_FILE_BYTES) {
      return yield* invalid("That isn't a secret file from request_secret.");
    }
    const value = (yield* fileSystem
      .readFileString(real)
      .pipe(Effect.mapError(() => expired))).replace(/\r?\n$/, "");
    if (!value) return yield* invalid("That secret file is empty.");
    return { value, path: real };
  });

  const saveLoginFromSecretFile: BotVault["Service"]["saveLoginFromSecretFile"] = Effect.fn(
    "BotVault.saveLoginFromSecretFile",
  )(function* (input) {
    if (!siteDomain(input.website)) {
      return yield* invalid("website must be a site address like https://example.com.");
    }
    const secret = yield* readRequestSecretFile(input.secretFile);
    const now = yield* nowIso;
    const id = yield* newId;
    const result = yield* mutate((items) =>
      Effect.gen(function* () {
        const draft = buildLogin(
          {
            websites: [input.website],
            username: input.username ?? "",
            password: secret.value,
            botCanRead: input.apiToken === true,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.hints === undefined ? {} : { hints: input.hints }),
          },
          { id, createdAt: now, now },
        );
        if (typeof draft === "string") return yield* invalid(draft);
        const same = sameLoginIndex(items, draft);
        const previous = same === -1 ? undefined : items[same];
        if (previous === undefined || previous.kind !== "login") {
          items.push(draft);
          return { next: items, result: { item: draft, updated: false } };
        }
        // A refresh through an already-saved site keeps the login's sites, title and order.
        const merged: StoredLogin = {
          ...previous,
          password: draft.password,
          botCanRead: draft.botCanRead,
          ...(input.title === undefined ? {} : { title: draft.title }),
          ...(input.hints === undefined ? {} : { hints: draft.hints }),
          updatedAt: now,
        };
        items[same] = merged;
        return { next: items, result: { item: merged, updated: true } };
      }),
    );
    yield* fileSystem.remove(secret.path, { force: true }).pipe(Effect.ignore);
    return { item: summarize(result.item) as BotVaultLoginSummary, updated: result.updated };
  });

  const resetSecretFilesDir = fileSystem
    .remove(secretFilesDir, { recursive: true, force: true })
    .pipe(
      Effect.andThen(fileSystem.makeDirectory(secretFilesDir, { recursive: true, mode: 0o700 })),
      Effect.andThen(fileSystem.chmod(secretFilesDir, 0o700)),
    );

  const writeSecretFile: BotVault["Service"]["writeSecretFile"] = Effect.fn(
    "BotVault.writeSecretFile",
  )(function* (item) {
    const file = path.join(secretFilesDir, NodeCrypto.randomBytes(16).toString("hex"));
    yield* fileSystem
      .makeDirectory(secretFilesDir, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.andThen(
          fileSystem.writeFileString(file, item.password, { mode: 0o600, flag: "wx" }),
        ),
        Effect.mapError(storage("Couldn't write the token file.")),
      );
    yield* fileSystem
      .remove(file, { force: true })
      .pipe(Effect.ignore, Effect.delay(SECRET_FILE_TTL), Effect.forkIn(layerScope));
    return { file, expiresInMinutes: Duration.toMinutes(SECRET_FILE_TTL) };
  });

  // Files from an earlier run have no timer left to delete them.
  yield* resetSecretFilesDir.pipe(Effect.ignoreCause({ log: true }));

  return BotVault.of({
    list,
    upsert,
    delete: deleteItem,
    reveal,
    importItems,
    login,
    saveLoginFromSecretFile,
    writeSecretFile,
  });
});

export const layer = Layer.effect(BotVault, make);
