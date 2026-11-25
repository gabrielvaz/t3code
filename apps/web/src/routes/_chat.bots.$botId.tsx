import { createFileRoute } from "@tanstack/react-router";

import { BotPage } from "../components/bots/BotPage";
import { validateBotPageSearch } from "../components/bots/botPageSearch";

function BotRoute() {
  const { botId } = Route.useParams();
  const { tab } = Route.useSearch();
  return <BotPage botId={botId} tab={tab ?? "details"} />;
}

export const Route = createFileRoute("/_chat/bots/$botId")({
  validateSearch: validateBotPageSearch,
  component: BotRoute,
});
