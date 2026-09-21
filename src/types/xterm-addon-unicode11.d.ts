import type { ITerminalAddon, Terminal } from "@xterm/xterm";

export class Unicode11Addon implements ITerminalAddon {
  constructor();
  activate(terminal: Terminal): void;
  dispose(): void;
}
