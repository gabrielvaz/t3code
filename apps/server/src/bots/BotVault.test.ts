import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { BotVaultItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as BotVault from "./BotVault.ts";
import { decryptVault, encryptVault, matchesSite, siteDomain } from "./BotVault.ts";

const randomBytes = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size));

const login = {
  kind: "login" as const,
  id: BotVaultItemId.make("login-1"),
  title: "GitHub",
  websites: ["https://github.com"],
  username: "octo",
  password: "hunter2",
  hints: "",
  botCanRead: false,
  createdAt: "2026-11-25T00:00:00.000Z",
  updatedAt: "2026-11-25T00:00:00.000Z",
};

describe("vault crypto", () => {
  it("round-trips items and keeps the password out of the file", () => {
    const key = randomBytes(32);
    const text = encryptVault(key, [login]);
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toMatchObject({ format: "t3-bots-vault", version: 1 });
    expect(decryptVault(key, text)).toEqual([login]);
  });

  it("refuses the wrong key and a tampered file without echoing either", () => {
    const text = encryptVault(randomBytes(32), [login]);
    const wrongKey = decryptVault(randomBytes(32), text);
    expect(typeof wrongKey).toBe("string");
    expect(wrongKey).not.toContain("hunter2");
    const envelope = JSON.parse(text);
    const tampered = JSON.stringify({ ...envelope, data: Buffer.from("x").toString("base64") });
    expect(typeof decryptVault(randomBytes(32), tampered)).toBe("string");
    expect(decryptVault(randomBytes(32), "not json")).toBe("The vault file is damaged.");
  });
});

describe("matchesSite", () => {
  it("matches the saved domain and its subdomains", () => {
    expect(siteDomain("https://www.PayPal.com/signin")).toBe("paypal.com");
    expect(matchesSite("https://paypal.com/login", "paypal.com")).toBe(true);
    expect(matchesSite("https://www.paypal.com/login", "https://paypal.com")).toBe(true);
    expect(matchesSite("https://accounts.paypal.com/", "paypal.com")).toBe(true);
  });

  it("refuses lookalikes, other schemes and plain http", () => {
    expect(matchesSite("https://paypal.com.evil.io/login", "paypal.com")).toBe(false);
    expect(matchesSite("https://xpaypal.com/", "paypal.com")).toBe(false);
    expect(matchesSite("https://paypal-login.com/", "paypal.com")).toBe(false);
    expect(matchesSite("https://evil.io/?next=paypal.com", "paypal.com")).toBe(false);
    expect(matchesSite("javascript:alert(1)", "paypal.com")).toBe(false);
    expect(matchesSite("http://paypal.com/", "paypal.com")).toBe(false);
    expect(matchesSite("http://router.local/", "http://router.local")).toBe(true);
    expect(matchesSite("https://paypal.com/", "")).toBe(false);
  });
});

const harness = () => {
  const store = new Map<string, Uint8Array>();
  const secretsDir = { current: "" };
  const layer = BotVault.layer.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const { secretsDir: dir } = yield* ServerConfig.ServerConfig;
          secretsDir.current = dir;
          return Layer.succeed(ServerSecretStore.ServerSecretStore, {
            directory: dir,
            get: (name) => Effect.sync(() => Option.fromNullishOr(store.get(name))),
            set: (name, value) => Effect.sync(() => void store.set(name, value)),
            create: (name, value) => Effect.sync(() => void store.set(name, value)),
            getOrCreateRandom: () => Effect.die("unused"),
            remove: (name) => Effect.sync(() => void store.delete(name)),
          });
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-vault-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { layer, store, secretsDir };
};

describe("BotVault", () => {
  it.effect("lists logins without passwords and reveals one on request", () => {
    const { layer, store } = harness();
    return Effect.gen(function* () {
      const vault = yield* BotVault.BotVault;
      expect((yield* vault.list).items).toEqual([]);
      // Listing an absent vault makes no key.
      expect(store.size).toBe(0);

      const { item } = yield* vault.upsert({
        kind: "login",
        websites: ["github.com"],
        username: "octo",
        password: "hunter2",
      });
      assert(item.kind === "login");
      expect(item).toMatchObject({ title: "github.com", websites: ["https://github.com"] });
      expect(item.hasPassword).toBe(true);
      expect(JSON.stringify((yield* vault.list).items)).not.toContain("hunter2");
      expect(store.has(BotVault.BOT_VAULT_KEY_NAME)).toBe(true);
      expect(yield* vault.reveal(item.id)).toBe("hunter2");

      // Omitting the password keeps it.
      yield* vault.upsert({ kind: "login", id: item.id, hints: "Work account" });
      expect(yield* vault.reveal(item.id)).toBe("hunter2");

      yield* vault.delete(item.id);
      expect((yield* vault.list).items).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays locked when the key is gone instead of making a new one", () => {
    const { layer, store } = harness();
    return Effect.gen(function* () {
      const vault = yield* BotVault.BotVault;
      yield* vault.upsert({ kind: "contact", name: "Ada" });
      store.clear();
      const locked = yield* vault.list.pipe(Effect.flip);
      expect(locked.reason).toBe("locked");
      const write = yield* vault.upsert({ kind: "contact", name: "Bob" }).pipe(Effect.flip);
      expect(write.reason).toBe("locked");
      expect(store.size).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("saves a login from a request_secret file only, then deletes the file", () => {
    const { layer, secretsDir } = harness();
    return Effect.gen(function* () {
      const vault = yield* BotVault.BotVault;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filesDir = path.join(secretsDir.current, "files");
      yield* fileSystem.makeDirectory(filesDir, { recursive: true });
      const secretFile = path.join(filesDir, "abc");
      yield* fileSystem.writeFileString(secretFile, "s3cret\n");
      const outside = path.join(secretsDir.current, "elsewhere");
      yield* fileSystem.writeFileString(outside, "nope");

      const refused = yield* vault
        .saveLoginFromSecretFile({ website: "https://example.com", secretFile: outside })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("invalid");

      const saved = yield* vault.saveLoginFromSecretFile({
        website: "https://example.com",
        secretFile,
        username: "me",
        apiToken: true,
      });
      expect(saved.updated).toBe(false);
      expect(yield* fileSystem.exists(secretFile)).toBe(false);
      const login = yield* vault.login(saved.item.id);
      expect(login.password).toBe("s3cret");

      // The same site and username updates the saved login.
      yield* fileSystem.writeFileString(secretFile, "n3w");
      const again = yield* vault.saveLoginFromSecretFile({
        website: "https://example.com/login",
        secretFile,
        username: "me",
        apiToken: true,
      });
      expect(again.updated).toBe(true);
      expect((yield* vault.list).items).toHaveLength(1);

      const token = yield* vault.writeSecretFile(yield* vault.login(saved.item.id));
      expect(yield* fileSystem.readFileString(token.file)).toBe("n3w");
      expect((yield* fileSystem.stat(token.file)).mode & 0o777).toBe(0o600);
    }).pipe(Effect.provide(layer));
  });

  it.effect("imports new rows, updates changed passwords and skips duplicates", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const vault = yield* BotVault.BotVault;
      const first = yield* vault.importItems([
        { kind: "login", websites: ["https://a.com"], username: "u", password: "1" },
        { kind: "contact", name: "Ada" },
        { kind: "login", username: "nobody" },
      ]);
      expect(first).toEqual({ added: 2, updated: 0, skipped: 1 });
      const second = yield* vault.importItems([
        { kind: "login", websites: ["https://a.com"], username: "u", password: "2" },
        { kind: "contact", name: "Ada" },
      ]);
      expect(second).toEqual({ added: 0, updated: 1, skipped: 1 });
    }).pipe(Effect.provide(layer));
  });
});
