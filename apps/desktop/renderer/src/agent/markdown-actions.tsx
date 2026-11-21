import { createContext, useContext, type ReactNode } from "react";
import type { OpenFileRequest } from "./use-file-viewer";
import type { FileEditorOption, OpenFileTargetMode } from "../../../src/shared/workspace-files.ts";

export interface MarkdownActions {
  readonly workspaceId?: string;
  readonly cloud: boolean;
  readonly editors: readonly FileEditorOption[];
  readonly openFile: (request: OpenFileRequest) => void;
  readonly openFileExternal: (input: {
    path: string;
    line?: number;
    column?: number;
    mode: OpenFileTargetMode;
  }) => Promise<void>;
  readonly openWebInBrowser: (url: string) => void;
  readonly openWebExternal: (url: string) => Promise<void>;
  readonly openGitHubPanel?: () => void;
  readonly onError?: (error: unknown) => void;
}

const MarkdownActionsContext = createContext<MarkdownActions | null>(null);

export function MarkdownActionsProvider({
  value,
  children,
}: {
  value: MarkdownActions;
  children?: ReactNode;
}) {
  return (
    <MarkdownActionsContext.Provider value={value}>{children}</MarkdownActionsContext.Provider>
  );
}

export function useMarkdownActions() {
  return useContext(MarkdownActionsContext);
}
