import { createFileRoute } from "@tanstack/react-router";

import { BotsSettings } from "../components/bots/BotsSettings";

export const Route = createFileRoute("/_chat/settings/bots")({
  component: BotsSettings,
});
