import { useResolvedTheme } from "@/appearance";
import { getSharedHighlighter, type ThemedToken } from "@pierre/diffs";
import { Check, Code2, Copy, WrapText } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

const names: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  py: "Python",
  python: "Python",
  sh: "Shell",
  bash: "Bash",
  shell: "Shell",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  md: "Markdown",
  markdown: "Markdown",
  rust: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
};

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  useTranslation();
  const theme = useResolvedTheme() === "dark" ? "pierre-dark" : "pierre-light";
  const [highlight, setHighlight] = useState<{
    code: string;
    language: string;
    theme: string;
    tokens: ThemedToken[][];
  }>();
  const [wrap, setWrap] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string>();
  const copied = copiedCode === code;
  useEffect(() => {
    let active = true;
    // Bound synchronous tokenization during streaming and for unusually large messages.
    if (!language || code.length > 100_000 || code.split("\n").some((line) => line.length > 2000))
      return;
    const timer = window.setTimeout(() => {
      void getSharedHighlighter({
        themes: [theme],
        langs: [language.toLowerCase()],
        preferredHighlighter: "shiki-js",
      })
        .then((highlighter) => {
          if (!active) return;
          const result = highlighter.codeToTokens(code, {
            lang: language.toLowerCase(),
            theme,
          });
          if (active) setHighlight({ code, language, theme, tokens: result.tokens });
        })
        .catch(() => {
          // Unknown languages remain readable as plain text.
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [code, language, theme]);
  const tokens =
    highlight?.code === code && highlight.language === language && highlight.theme === theme
      ? highlight.tokens
      : undefined;
  const label = language
    ? Object.hasOwn(names, language.toLowerCase())
      ? names[language.toLowerCase()]
      : language
    : t("chat:codeBlock.plainText");
  return (
    <div className="my-3 max-w-full overflow-hidden rounded-xl border border-border bg-surface-subtle text-foreground">
      <div className="flex items-center gap-2 px-4 pt-2 text-xs font-medium">
        <Code2 size={15} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("chat:codeBlock.wrap")}
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t(copied ? "chat:codeBlock.copied" : "chat:codeBlock.copy")}
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => setCopiedCode(code))
              .catch(() => setCopiedCode(undefined));
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </Button>
      </div>
      <pre
        className={
          wrap
            ? "overflow-auto px-4 pb-4 pt-2 whitespace-pre-wrap break-words"
            : "overflow-auto px-4 pb-4 pt-2 whitespace-pre"
        }
      >
        <code>
          {tokens
            ? tokens.map((line, i) => (
                <span key={i}>
                  {line.map((token, j) => (
                    <span
                      key={j}
                      style={{
                        color: token.color,
                        fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
                      }}
                    >
                      {token.content}
                    </span>
                  ))}
                  {i < tokens.length - 1 ? "\n" : ""}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
