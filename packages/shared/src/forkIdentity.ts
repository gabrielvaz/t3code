/**
 * Identity of the unofficial "T3 Bots" fork (not affiliated with T3 Tools, Inc.; see TRADEMARK.md),
 * so packaged builds install beside T3 Code without sharing app id, profile, home, scheme or service.
 * Development keeps the upstream `t3code-dev` identity.
 */
export const FORK_IDENTITY = {
  /** macOS bundle id / Windows AppUserModelID of packaged builds. */
  appId: "com.gabrielvaz.t3bots",
  /** Bundle and installer name. */
  productName: "T3 Bots",
  /** Short name in menus, the About panel and the renderer branding. */
  baseName: "T3 Bots",
  /** Shown in the About panel so the app is never mistaken for T3 Code. */
  displayName: "T3 Bots (unofficial fork of T3 Code)",
  description: "Unofficial fork of T3 Code. Not affiliated with T3 Tools, Inc.",
  /** Electron profile directory under the OS app-data folder. */
  userDataDirName: "t3bots",
  /** Default T3 home under the user's home directory when T3CODE_HOME is unset. */
  t3HomeDirName: ".t3-bots",
  /** Production renderer origin and app-link scheme (`t3bots://app`). */
  urlScheme: "t3bots",
  /** systemd unit / Task Scheduler task name of the optional background service. */
  serviceName: "t3bots",
  /** launchd label of the optional background service. */
  launchdServiceLabel: "com.gabrielvaz.t3bots.service",
  /** The fork has no update feed; packaged builds never auto-update. */
  autoUpdate: false,
} as const;
