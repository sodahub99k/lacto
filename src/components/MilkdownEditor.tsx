import { useEffect, useMemo, useRef, useState } from "react";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { nord } from "@milkdown/theme-nord";
import { replaceAll } from "@milkdown/utils";

import "@milkdown/theme-nord/style.css";

const DEFAULT_MD = `# Milkdown Split Demo\n\n左が *Markdown ソース*、右が **WYSIWYG**（Milkdown）です。\n\n- 両側どちらで編集しても同期します\n- ソース側は入力中の負荷を避けるためデバウンスで反映します\n\n## Code\n\n\`\`\`ts\nexport const hello = (name: string) => \`Hello, \${name}\`\n\`\`\`\n`;

type Props = {
  initialMarkdown?: string;
  debounceMs?: number;
};

const InnerEditor: React.FC<Props> = ({
  initialMarkdown = DEFAULT_MD,
  debounceMs = 250,
}) => {
  const initial = useMemo(() => initialMarkdown, [initialMarkdown]);

  const [markdown, setMarkdown] = useState<string>(initial);

  const markdownRef = useRef(markdown);
  useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  const applyingFromSourceRef = useRef(false);
  const lastMarkdownFromEditorRef = useRef<string>(initial);

  const editorFactory = useMemo(() => {
    return (root: HTMLElement) => {
      return Editor.make()
        .config(nord)
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initial);

          ctx.get(listenerCtx).markdownUpdated((_ctx, nextMarkdown) => {
            lastMarkdownFromEditorRef.current = nextMarkdown;

            if (applyingFromSourceRef.current) return;
            if (nextMarkdown === markdownRef.current) return;

            setMarkdown(nextMarkdown);
          });
        })
        .use(commonmark)
        .use(listener);
    };
  }, [initial]);

  const { get } = useEditor(editorFactory);

  useEffect(() => {
    const editor = get();
    if (!editor) return;

    if (markdown === lastMarkdownFromEditorRef.current) return;

    const timer = window.setTimeout(() => {
      const currentEditor = get();
      if (!currentEditor) return;

      applyingFromSourceRef.current = true;
      try {
        currentEditor.action(replaceAll(markdown, true));
      } finally {
        queueMicrotask(() => {
          applyingFromSourceRef.current = false;
        });
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [debounceMs, get, markdown]);

  return (
    <div className="split">
      <section className="pane">
        <div className="pane-header">
          <div className="pane-title">Markdown</div>
        </div>
        <div className="pane-body">
          <textarea
            className="source"
            value={markdown}
            onChange={(e) => setMarkdown(e.currentTarget.value)}
            spellCheck={false}
          />
        </div>
      </section>

      <section className="pane">
        <div className="pane-header">
          <div className="pane-title">WYSIWYG</div>
        </div>
        <div className="pane-body">
          <div className="milkdown-shell">
            <Milkdown />
          </div>
        </div>
      </section>
    </div>
  );
};

const MilkdownEditorDemo: React.FC = () => {
  return (
    <MilkdownProvider>
      <InnerEditor />
    </MilkdownProvider>
  );
};

export default MilkdownEditorDemo;
