import { createFileRoute } from "@tanstack/react-router";

import { BotRoomPage } from "../components/bots/BotRoomPage";

function BotRoomRoute() {
  const { roomId } = Route.useParams();
  return <BotRoomPage roomId={roomId} />;
}

export const Route = createFileRoute("/_chat/bots/rooms/$roomId")({
  component: BotRoomRoute,
});
