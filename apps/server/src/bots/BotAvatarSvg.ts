// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous sha256 keeps this helper pure
import * as NodeCrypto from "node:crypto";

/** `avatar-<hash>.svg`: a new name per look, so cached favicons never go stale. */
export function botAvatarFileName(svg: string): string {
  return `avatar-${NodeCrypto.createHash("sha256").update(svg).digest("hex").slice(0, 12)}.svg`;
}
