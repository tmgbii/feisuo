import type { IEvent, ITerminalAddon, Terminal } from "@xterm/xterm";

export interface ISearchOptions {
  regex?: boolean;
  wholeWord?: boolean;
  caseSensitive?: boolean;
  incremental?: boolean;
  decorations?: ISearchDecorationOptions;
}

export interface ISearchDecorationOptions {
  matchBackground?: string;
  matchBorder?: string;
  matchOverviewRuler: string;
  activeMatchBackground?: string;
  activeMatchBorder?: string;
  activeMatchColorOverviewRuler: string;
}

export interface ISearchResultChangeEvent {
  resultIndex: number;
  resultCount: number;
}

export interface ISearchAddonOptions {
  highlightLimit: number;
}

export class SearchAddon implements ITerminalAddon {
  constructor(options?: Partial<ISearchAddonOptions>);
  activate(terminal: Terminal): void;
  dispose(): void;
  findNext(term: string, searchOptions?: ISearchOptions): boolean;
  findPrevious(term: string, searchOptions?: ISearchOptions): boolean;
  clearDecorations(): void;
  clearActiveDecoration(): void;
  readonly onDidChangeResults: IEvent<ISearchResultChangeEvent>;
}
