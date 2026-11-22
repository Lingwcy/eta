import { useContext, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";
import {
  FileLinkBlock,
  GitHubReferenceBlock,
  InsideMarkdownLinkContext,
  WebLinkBlock,
} from "./markdown-blocks";
import {
  classifyMarkdownLink,
  markdownUrlTransform,
  parseInlineCodeFileReference,
} from "./markdown-targets";

const plugins = [remarkGfm];

const externalLinkClass =
  "text-info-text-600 underline decoration-info-text-600/40 underline-offset-2 hover:decoration-info-text-600 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info-text-600";

function MarkdownInlineCode({
  className,
  children,
  preview = false,
  ...props
}: ComponentPropsWithoutRef<"code"> & { preview?: boolean }) {
  const insideLink = useContext(InsideMarkdownLinkContext);
  const text = typeof children === "string" ? children : undefined;
  const isFencedLanguage = typeof className === "string" && className.includes("language-");

  if (!insideLink && !isFencedLanguage && text && !text.includes("\n")) {
    const file = parseInlineCodeFileReference(text);
    if (file) {
      return <FileLinkBlock file={file} label={file.name} showLineSuffix preview={preview} />;
    }
  }

  if (insideLink) {
    return (
      <code {...props} className={className ? `${className} font-mono` : "font-mono"}>
        {children}
      </code>
    );
  }

  if (isFencedLanguage || (text && text.includes("\n"))) {
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  }

  return (
    <code
      {...props}
      className="rounded-[5px] border border-border-soft bg-surface-subtle/80 px-1.5 py-px font-mono text-[0.87em] text-heading"
    >
      {children}
    </code>
  );
}

function createMarkdownComponents(preview: boolean): Components {
  return {
    pre: ({ node, children }) => {
      if (preview) return <pre>{children}</pre>;
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
    code: ({ node: _node, ...props }) => <MarkdownInlineCode {...props} preview={preview} />,
    table: ({ node: _node, ...props }) => (
      <div className="my-3 max-w-full overflow-x-auto">
        <table {...props} className="w-full border-collapse text-left" />
      </div>
    ),
    th: ({ node: _node, ...props }) => (
      <th {...props} className="min-w-24 border-b border-border px-3 py-2 align-top font-medium" />
    ),
    td: ({ node: _node, ...props }) => (
      <td {...props} className="border-b border-border-soft px-3 py-2 align-top" />
    ),
    a: ({ node: _node, href, children }) => {
      const target = classifyMarkdownLink(href);
      switch (target.kind) {
        case "file":
          return <FileLinkBlock file={target.file} label={children} preview={preview} />;
        case "github-pr":
        case "github-issue":
          return (
            <GitHubReferenceBlock target={target} preview={preview}>
              {children}
            </GitHubReferenceBlock>
          );
        case "web":
          return (
            <WebLinkBlock target={target} preview={preview}>
              {children}
            </WebLinkBlock>
          );
        case "external":
          if (preview) return <span className={externalLinkClass}>{children}</span>;
          return (
            <a
              href={target.url}
              target="_blank"
              rel="noopener noreferrer"
              className={externalLinkClass}
            >
              {children}
            </a>
          );
        case "unsafe":
          return <span>{children}</span>;
      }
    },
  };
}

const components = createMarkdownComponents(false);
const previewComponents = createMarkdownComponents(true);

/** Renders chat Markdown with interactive file, GitHub PR/Issue, and web link blocks. */
export function MessageMarkdown({ text, preview = false }: { text: string; preview?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      urlTransform={markdownUrlTransform}
      components={preview ? previewComponents : components}
    >
      {text}
    </ReactMarkdown>
  );
}
