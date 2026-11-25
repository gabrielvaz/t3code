import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type BotUpdateInput } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { requestConfirmDialog } from "../../confirmDialog";
import { m } from "../../i18n/messages";
import type { EnvironmentBot } from "../../state/bots";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Update and delete for one Bot, shared by the sidebar menu and the Bot page. */
export function useBotActions() {
  const gt = useGT();
  const updateBot = useAtomCommand(serverEnvironment.updateBot, {
    label: "bot update",
    reportFailure: false,
  });
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, {
    label: "bot delete",
    reportFailure: false,
  });
  const reportFailure = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? undefined,
      }),
    );

  const update = async (
    entry: EnvironmentBot,
    patch: Omit<BotUpdateInput, "id">,
  ): Promise<boolean> => {
    if (!readEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope)) return false;
    const result = await updateBot({
      environmentId: entry.environmentId,
      input: { id: entry.bot.id, ...patch },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      reportFailure(
        gt("Could not update {name}", { name: entry.bot.name }),
        squashAtomCommandFailure(result),
      );
    }
    return false;
  };

  const confirmAndDelete = async (entry: EnvironmentBot): Promise<boolean> => {
    if (!readEnvironmentScope(entry.environmentId, AuthOrchestrationOperateScope)) return false;
    const message = `${gt("Delete {name}?", { name: entry.bot.name })}\n${gt(
      "Its thread is deleted and its folder, with its memory and instructions, moves to the Bots trash on the server.",
    )}`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return false;
    const result = await deleteBot({
      environmentId: entry.environmentId,
      input: { id: entry.bot.id },
    });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      reportFailure(
        gt("Could not delete {name}", { name: entry.bot.name }),
        squashAtomCommandFailure(result),
      );
    }
    return false;
  };

  return { update, confirmAndDelete };
}
