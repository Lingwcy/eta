import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";

const plugins = [remarkGfm];
const components: Components = {
  pre: ({ node, children }) => {
    const element = node?.children[0];
    if (!element || element.type !== "element" || element.tagName !== "code")
      return <pre>{children}</pre>;
    const code = element.children
      .map((child) => (child.type === "text" ? child.value : ""))
      .join("")
      .replace(/\n$/, "");
    const classes = element.properties.className;
    const language = Array.isArray(classes)
      ? classes.find((name) => typeof name === "string" && name.startsWith("language-"))
      : undefined;
    return (
      <CodeBlock
        code={code}
        language={typeof language === "string" ? language.slice(9) : undefined}
      />
    );
  },
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

const previewComponents: Components = {
  ...components,
  pre: ({ children }) => <pre>{children}</pre>,
};

/** Links open through the desktop window's external navigation handler. */
export function MessageMarkdown({ text, preview = false }: { text: string; preview?: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={preview ? previewComponents : components}>
      {text}
    </ReactMarkdown>
  );
}
