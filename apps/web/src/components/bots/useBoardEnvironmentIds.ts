import type { EnvironmentId } from "@t3tools/contracts";

import { useServerConfigs } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";

/** The connected environments whose server has Labs › Projects board turned on. */
export function useBoardEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const connectedIds = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  return connectedIds.filter((id) => configs.get(id)?.settings.botsProjectsBoardEnabled === true);
}
