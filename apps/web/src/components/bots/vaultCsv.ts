// Adapted from Threebot web/src/lib/vaultCsv.ts (MIT, Copyright (c) 2026 Threebot contributors).
//
// Reads password-manager CSV exports in the browser. The file never leaves this device; only the
// parsed rows go to the server.
import type { BotVaultImportItem } from "@t3tools/contracts";

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

export type VaultCsvFormat =
  | "1Password"
  | "Chrome or Edge"
  | "Safari or Apple Passwords"
  | "Firefox"
  | "Bitwarden"
  | "LastPass"
  | "Contact info"
  | "CSV";

export interface VaultCsvImport {
  readonly format: VaultCsvFormat;
  readonly items: ReadonlyArray<BotVaultImportItem>;
  readonly skipped: number;
}

const ALIASES = {
  title: ["name", "title"],
  url: ["url", "login_uri", "website", "urls", "login url", "web site", "uri", "location"],
  username: ["username", "login_username", "user name", "login", "login name", "email", "user"],
  password: ["password", "login_password"],
  note: ["note", "notes", "extra", "comments", "comment"],
} as const;

function detect(header: ReadonlyArray<string>): VaultCsvFormat {
  const has = (name: string) => header.includes(name);
  if (has("street") || (has("label") && has("name") && !has("password"))) return "Contact info";
  if (has("login_uri") || has("login_password")) return "Bitwarden";
  if (has("httprealm") || has("formactionorigin") || has("timepasswordchanged")) return "Firefox";
  if (has("grouping") || (has("extra") && has("url"))) return "LastPass";
  if (has("otpauth") && (has("favorite") || has("archived") || has("tags"))) return "1Password";
  if (has("otpauth") && has("title")) return "Safari or Apple Passwords";
  if (has("title") && (has("website") || has("url")) && has("password")) return "1Password";
  if (has("name") && has("url") && has("password")) return "Chrome or Edge";
  return "CSV";
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const splitList = (value: string) =>
  value
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

export function parseVaultCsv(text: string): VaultCsvImport {
  const rows = parseCsv(text);
  const [first, ...body] = rows;
  if (first === undefined || body.length === 0) return { format: "CSV", items: [], skipped: 0 };
  const header = first.map((cell) => cell.trim().toLowerCase());
  const format = detect(header);
  const column = (row: ReadonlyArray<string>, names: ReadonlyArray<string>) => {
    for (const name of names) {
      const index = header.indexOf(name);
      const value = index === -1 ? undefined : row[index];
      if (value?.trim()) return value;
    }
    return "";
  };
  const items: BotVaultImportItem[] = [];
  let skipped = 0;

  for (const row of body) {
    if (format === "Contact info") {
      const get = (name: string) => column(row, [name]).trim();
      const contact = {
        kind: "contact" as const,
        label: get("label"),
        name: get("name"),
        emails: splitList(get("emails") || get("email")),
        phones: splitList(get("phones") || get("phone")),
        street: get("street"),
        apt: get("apt"),
        city: get("city"),
        state: get("state"),
        zip: get("zip"),
        country: get("country"),
      };
      if (
        contact.label ||
        contact.name ||
        contact.emails.length > 0 ||
        contact.phones.length > 0 ||
        contact.street
      ) {
        items.push(contact);
      } else skipped++;
      continue;
    }
    // Bitwarden exports notes and cards too; LastPass marks secure notes with http://sn.
    const type = column(row, ["type"]).trim().toLowerCase();
    if (format === "Bitwarden" && type && type !== "login") {
      skipped++;
      continue;
    }
    const rawUrl = column(row, ALIASES.url).trim();
    if (format === "LastPass" && /^https?:\/\/sn\/?$/i.test(rawUrl)) {
      skipped++;
      continue;
    }
    // Several URIs in one field (Bitwarden, 1Password) become the login's sites.
    const websites = [...new Set(rawUrl.split(/[,\s]+/).filter(Boolean))].slice(0, 20);
    const password = column(row, ALIASES.password);
    const username = column(row, ALIASES.username).trim();
    const title = column(row, ALIASES.title).trim() || hostname(websites[0] ?? "");
    if ((!password && !username) || (websites.length === 0 && !title)) {
      skipped++;
      continue;
    }
    items.push({
      kind: "login",
      title,
      websites,
      username,
      password,
      hints: column(row, ALIASES.note).trim(),
    });
  }
  return { format, items, skipped };
}
