import { createFileRoute } from "@tanstack/react-router";

import { BotsBoardPage } from "../components/bots/BotsBoardPage";

export const Route = createFileRoute("/_chat/bots/board")({
  component: BotsBoardPage,
});
