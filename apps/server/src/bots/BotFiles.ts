// Slugs are ported from Threebot (MIT, Copyright (c) 2026 Threebot contributors).
//
// Layout of the bots root (`<stateDir>/bots`):
//   <slug>/.bot/bot.json        the record
//   <slug>/AGENTS.md, CLAUDE.md the instructions every provider reads
//   <slug>/memory/MEMORY.md     the Bot's memory, plus memory/log.md
//   .shared/                    shared memory and settings
//   .trash/<slug>-<ts>/         deleted Bots
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SLUG_MAX = 40;

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "bot";
}

/** The first of `slug`, `slug-2`, `slug-3`… that `taken` does not hold. */
export function freeSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface BotPaths {
  readonly dir: string;
  readonly record: string;
  readonly agents: string;
  readonly claude: string;
  readonly memory: string;
  readonly log: string;
  readonly library: string;
  readonly botDir: string;
}

export function botPaths(path: Path.Path, root: string, slug: string): BotPaths {
  const dir = path.join(root, slug);
  return {
    dir,
    botDir: path.join(dir, ".bot"),
    record: path.join(dir, ".bot", "bot.json"),
    agents: path.join(dir, "AGENTS.md"),
    claude: path.join(dir, "CLAUDE.md"),
    memory: path.join(dir, "memory", "MEMORY.md"),
    log: path.join(dir, "memory", "log.md"),
    library: path.join(dir, "library"),
  };
}

interface SharedPaths {
  readonly dir: string;
  readonly memory: string;
  readonly settings: string;
  readonly trash: string;
}

export function sharedPaths(path: Path.Path, root: string): SharedPaths {
  return {
    dir: path.join(root, ".shared"),
    memory: path.join(root, ".shared", "shared-memory.md"),
    settings: path.join(root, ".shared", "settings.json"),
    trash: path.join(root, ".trash"),
  };
}

export const readTextIfExists = Effect.fn("BotFiles.readTextIfExists")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem
    .readFileString(file)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));
});

/** Writes through a temp name and a rename, so a reader never sees half a file. */
export const writeTextAtomic = Effect.fn("BotFiles.writeTextAtomic")(function* (
  file: string,
  content: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${(yield* Clock.currentTimeMillis).toString(36)}.tmp`;
  yield* fileSystem.writeFileString(temp, content).pipe(
    Effect.andThen(fileSystem.rename(temp, file)),
    Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)),
  );
});

/** Writes only when the content differs, so watchers and favicons see no churn. */
export const writeTextIfChanged = Effect.fn("BotFiles.writeTextIfChanged")(function* (
  file: string,
  content: string,
) {
  const current = yield* readTextIfExists(file);
  if (current === content) return false;
  yield* writeTextAtomic(file, content);
  return true;
});

/** Moves a Bot's folder to `.trash/<slug>-<timestamp>`; nothing is deleted. */
export const trashFolder = Effect.fn("BotFiles.trashFolder")(function* (
  root: string,
  slug: string,
  nowMs: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { trash } = sharedPaths(path, root);
  yield* fileSystem.makeDirectory(trash, { recursive: true });
  const target = path.join(trash, `${slug}-${nowMs}`);
  yield* fileSystem.rename(path.join(root, slug), target);
  return target;
});
