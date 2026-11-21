import { useEffect } from "react";
import type { Machine } from "../../shared/machines.ts";
import { tabPaneTitle } from "../components/Sidebar.tsx";
import { usePaneLinkOpener } from "../lib/webPanel.ts";
import { useNotificationState } from "../lib/useNotifications.ts";
import { useForkNotificationState } from "./friends/notifications.ts";
import { ComputerView } from "./computer/ComputerView.tsx";
import { forgetComputerLogins, useComputerView } from "./computer/computerSettings.ts";
import { useAgentFriends } from "./friends/friends.ts";
import { PiVoiceView } from "./voice/PiVoiceView.tsx";
import { useInboxWidget } from "./inboxWidget.ts";

/** The fork's retained desktop, phone voice, friends and desktop-script title contract. */
export function useForkApp({ machines, selectedMachine, selectedMachineId, selectedPaneId, snapshot, inboxShown, openWebPage }: {
  machines: Machine[];
  selectedMachine: Machine | undefined;
  selectedMachineId: string;
  selectedPaneId: string | null;
  snapshot: Machine["snapshot"];
  inboxShown: boolean;
  openWebPage: Parameters<typeof usePaneLinkOpener>[1];
}) {
  const notificationState = useNotificationState();
  useForkNotificationState(notificationState.notifications, notificationState.setNotifications, machines);
  const [screenMachineId, setScreenMachineId, keptScreenId] = useComputerView();
  const machineName = (id: string) => machines.find((item) => item.id === id)?.name ?? id;
  const openPaneLink = usePaneLinkOpener(machines, openWebPage);
  useAgentFriends(machines);
  useInboxWidget();
  const pane = snapshot?.panes.find((item) => item.pane_id === selectedPaneId);
  const tabTitle = pane && !inboxShown ? tabPaneTitle(pane) : null;
  const screenName = screenMachineId !== null ? machineName(screenMachineId) : null;
  useEffect(() => {
    // Desktop scripts use [host pane]; Screen's prefix enables remote keyboard pass-through.
    const host = selectedMachine?.kind === "local" ? selectedMachine.name : selectedMachine?.target?.destination;
    const suffix = host && selectedPaneId ? ` [${host} ${selectedPaneId}]` : "";
    document.title = screenName !== null
      ? `Screen · ${screenName} · Ovis${suffix}`
      : tabTitle
        ? `${tabTitle} · ${selectedMachine?.name ?? selectedMachineId} · Ovis${suffix}`
        : "Ovis";
  }, [tabTitle, screenName, selectedMachine, selectedMachineId, selectedPaneId]);
  const desktopId = screenMachineId ?? keptScreenId;
  return {
    ...notificationState,
    screenMachineId, setScreenMachineId, machineName, openPaneLink, forgetComputerLogins,
    computerView: desktopId !== null ? <ComputerView key={desktopId} machineId={desktopId} machineName={machineName(desktopId)} hidden={screenMachineId === null} /> : null,
    phoneVoice: <PiVoiceView />,
  };
}
