// @mention rules for Bot rooms, ported from Threebot server/mention-rules.mts
// (MIT, Copyright (c) 2026 Threebot contributors). The composer, the message view and the
// server's room engine share them so `@Name` means the same thing everywhere.

const MENTION_BOUNDARY_PREV = /[\s([{<'"“`*~.]/;
const MAX_QUERY = 32;

/** True when the `@` at `at` starts a mention rather than sitting inside an email or a path. */
export function isMentionBoundary(text: string, at: number): boolean {
  if (at < 0 || at >= text.length || text[at] !== "@") return false;
  if (at === 0) return true;
  const prev = text[at - 1] ?? "";
  if (/[a-zA-Z0-9_/@]/.test(prev)) return false;
  return MENTION_BOUNDARY_PREV.test(prev);
}

function isNameContinuation(rest: string): boolean {
  return rest.length > 0 && /[\p{L}\p{N}_]/u.test(rest[0] ?? "");
}

/** The `@query` being typed at the cursor, or null when the cursor is not in one. */
export function mentionQueryAt(
  text: string,
  cursor: number,
  names?: ReadonlyArray<string>,
): { readonly start: number; readonly query: string } | null {
  if (cursor < 0 || cursor > text.length) return null;
  for (let index = cursor - 1; index >= Math.max(0, cursor - MAX_QUERY - 1); index--) {
    const char = text[index];
    if (char === "\n" || char === "\r") return null;
    if (char !== "@") continue;
    if (!isMentionBoundary(text, index)) return null;
    const query = text.slice(index + 1, cursor);
    if (query.length > MAX_QUERY) return null;
    // A finished mention followed by a space is no longer a query.
    if (names?.some((name) => query.toLowerCase() === `${name.toLowerCase()} `)) return null;
    return { start: index, query };
  }
  return null;
}

/** Blanks fenced and inline code with spaces, keeping every index where it was. */
function maskCode(source: string): string {
  const withoutFences = source.replace(
    /(^|\n)[ \t]*(```+|~~~+)[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g,
    (match, prefix: string) => prefix + " ".repeat(match.length - prefix.length),
  );
  return withoutFences.replace(/(`+)[\s\S]*?\1/g, (match) => " ".repeat(match.length));
}

export interface MentionSegment {
  readonly text: string;
  /** The canonical name when this run is a mention. */
  readonly name?: string;
}

/**
 * Splits `text` into plain runs and mentions: same boundary rule, longest name first, nothing
 * inside code. Each segment's `text` is the original slice.
 */
export function mentionSegments(
  text: string,
  names: ReadonlyArray<string>,
): ReadonlyArray<MentionSegment> {
  const masked = maskCode(text);
  const lowered = masked.toLowerCase();
  const candidates = [...new Set(names.filter((name) => name.trim() !== ""))].sort(
    (left, right) => right.length - left.length,
  );
  const canonical = (matched: string) =>
    names.find((name) => name.toLowerCase() === matched.toLowerCase()) ?? matched;
  const segments: MentionSegment[] = [];
  let plain = "";
  let index = 0;
  while (index < masked.length) {
    if (masked[index] === "@" && isMentionBoundary(masked, index)) {
      const hit = candidates.find(
        (candidate) =>
          lowered.startsWith(candidate.toLowerCase(), index + 1) &&
          !isNameContinuation(masked.slice(index + 1 + candidate.length)),
      );
      if (hit !== undefined) {
        if (plain !== "") segments.push({ text: plain });
        plain = "";
        segments.push({ text: text.slice(index, index + 1 + hit.length), name: canonical(hit) });
        index += 1 + hit.length;
        continue;
      }
    }
    plain += text[index];
    index += 1;
  }
  if (plain !== "") segments.push({ text: plain });
  return segments;
}

/** `@all` and `@everyone` address the whole room. */
const EVERYONE_MENTIONS = ["all", "everyone"] as const;

export type MentionPolicy = "anywhere" | "leading";

/**
 * The names `text` mentions, `all` included. `leading` only counts mentions that open the
 * message (`@Ana, @Bo and @Cy …`); `anywhere` counts them all.
 */
export function mentionsInText(
  text: string,
  names: ReadonlyArray<string>,
  policy: MentionPolicy,
): ReadonlyArray<string> {
  const everyone = [...names, ...EVERYONE_MENTIONS];
  if (policy === "anywhere") {
    return [...new Set(mentionSegments(text, everyone).flatMap((segment) => segment.name ?? []))];
  }
  const masked = maskCode(text);
  const candidates = [...new Set(everyone)].sort((left, right) => right.length - left.length);
  const canonical = (matched: string) =>
    everyone.find((name) => name.toLowerCase() === matched.toLowerCase()) ?? matched;
  const results: string[] = [];
  let index = masked.search(/\S/);
  if (index === -1) return [];
  while (index < masked.length) {
    if (masked[index] !== "@" || !isMentionBoundary(masked, index)) break;
    const hit = candidates.find(
      (candidate) =>
        masked
          .slice(index + 1)
          .toLowerCase()
          .startsWith(candidate.toLowerCase()) &&
        !isNameContinuation(masked.slice(index + 1 + candidate.length)),
    );
    if (hit === undefined) break;
    results.push(canonical(hit));
    index += 1 + hit.length;
    const separator = /^(\s*(?:,|and|&|\s)\s*)+/i.exec(masked.slice(index));
    if (separator === null) break;
    index += separator[0].length;
    if (masked[index] !== "@") break;
  }
  return [...new Set(results)];
}

export interface MentionMember {
  readonly id: string;
  readonly name: string;
}

/** The members `text` addresses, by id; `all` when it names the whole room. */
export function addressedMembers(
  text: string,
  members: ReadonlyArray<MentionMember>,
  policy: MentionPolicy,
): { readonly ids: ReadonlyArray<string>; readonly all: boolean } {
  const matched = mentionsInText(
    text,
    members.map((member) => member.name),
    policy,
  );
  const lowered = new Set(matched.map((name) => name.toLowerCase()));
  if (EVERYONE_MENTIONS.some((name) => lowered.has(name))) {
    return { ids: members.map((member) => member.id), all: true };
  }
  const byName = new Map(members.map((member) => [member.name.toLowerCase(), member.id]));
  const ids = matched.flatMap((name) => byName.get(name.toLowerCase()) ?? []);
  return { ids: [...new Set(ids)], all: false };
}
