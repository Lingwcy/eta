import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  title: string;
  archived: boolean;
  busy: boolean;
  canArchive: boolean;
  canCompact: boolean;
  editingTitle: string | null;
  onEditingTitle: (title: string | null) => void;
  onRename: () => void;
  onArchive: () => void;
  onCompact: () => void;
}
export function ThreadHeader(props: Props) {
  return (
    <>
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-2.5 min-[901px]:px-6">
        <span className="min-w-0 truncate text-sm font-semibold">{props.title}</span>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={props.busy}
            onClick={() => props.onEditingTitle(props.title)}
          >
            重命名
          </Button>
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={!props.canArchive}
            onClick={props.onArchive}
          >
            {props.archived ? "恢复归档" : "归档"}
          </Button>
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={!props.canCompact}
            onClick={props.onCompact}
          >
            压缩上下文
          </Button>
        </div>
      </header>
      {props.editingTitle !== null && (
        <form
          className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onRename();
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              aria-label="会话标题"
              value={props.editingTitle}
              onValueChange={props.onEditingTitle}
              required
            />
          </div>
          <Button size="sm" type="submit" disabled={props.busy}>
            保存
          </Button>
          <Button variant="ghost" size="sm" onClick={() => props.onEditingTitle(null)}>
            取消
          </Button>
        </form>
      )}
    </>
  );
}
