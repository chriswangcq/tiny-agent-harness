import type {
  SessionListObservation,
  TerminalObservation,
  TerminalToolRequest,
} from "../terminal/types.js";

export type TerminalActionRequest = {
  request: TerminalToolRequest;
};

export type TerminalActionObservation =
  | TerminalObservation
  | SessionListObservation;

export interface TerminalActionService {
  handleAction(request: TerminalToolRequest): Promise<TerminalActionObservation>;
}

export function createTerminalRunPort(service: TerminalActionService): {
  execute(request: TerminalActionRequest): Promise<TerminalActionObservation>;
} {
  return {
    execute(request) {
      return service.handleAction(request.request);
    },
  };
}
