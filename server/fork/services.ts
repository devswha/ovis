import type { WebSocketHandler } from "bun";
import type { DeviceStore } from "../devices.ts";
import { FriendStore } from "./friends.ts";
import { OmarchyThemeStore } from "./omarchy-themes.ts";
import { PiVoiceHub, withPiVoiceSockets, type PiVoiceSocketData } from "./pi-voice.ts";
import { withScreenSockets, type ScreenSocketData } from "./screen.ts";
import { SpeechService } from "./speech.ts";

export type ForkSocketData = ScreenSocketData | PiVoiceSocketData;
export interface ForkServices {
  readonly omarchyThemes: OmarchyThemeStore;
  readonly friends: FriendStore;
  readonly speech: SpeechService;
  readonly piVoice: PiVoiceHub;
}

export function createForkServices(stateDir: string, devices: DeviceStore, speech?: SpeechService): ForkServices {
  return {
    omarchyThemes: new OmarchyThemeStore(stateDir),
    friends: new FriendStore(stateDir),
    speech: speech ?? new SpeechService({ stateDir }),
    piVoice: new PiVoiceHub({ onRevoke: (id, close) => devices.onRevoke(id, close) }),
  };
}

export function withForkSockets<T extends object>(core: WebSocketHandler<T>, services: ForkServices): WebSocketHandler<T | ForkSocketData> {
  return withPiVoiceSockets(withScreenSockets(core), services.piVoice);
}
