import type { PtyAction, PtyObservation } from "../terminal/types.js";

export type TerminalActionRequest = {
  action: PtyAction;
};

export interface TerminalActionService {
  handleAction(action: PtyAction): Promise<PtyObservation>;
}

export function createTerminalRunPort(service: TerminalActionService): {
  execute(request: TerminalActionRequest): Promise<PtyObservation>;
} {
  return {
    execute(request) {
      return service.handleAction(request.action);
    },
  };
}
