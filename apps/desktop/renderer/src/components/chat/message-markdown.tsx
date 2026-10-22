import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];
const components: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="my-3 max-w-full overflow-x-auto">
      <table {...props} className="w-full border-collapse text-left" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="min-w-24 border-b border-neutral-200 px-3 py-2 align-top font-medium"
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td {...props} className="border-b border-neutral-100 px-3 py-2 align-top" />
  ),
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
    />
  ),
};

/** Links open through the desktop window's external navigation handler. */
export function MessageMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
}
