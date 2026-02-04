import { useEffect, useMemo, useRef, useState } from "react";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { nord } from "@milkdown/theme-nord";
import { replaceAll } from "@milkdown/utils";
import { editorViewCtx } from "@milkdown/core";

type ProseLikeDoc = {
  descendants: (fn: (node: any, pos: number) => void) => void;
  forEach: (fn: (node: any, offset: number) => void) => void;
};

type ProseLikeView = {
  state: {
    doc: ProseLikeDoc;
  };
  coordsAtPos: (pos: number) => { top: number };
};

import "@milkdown/theme-nord/style.css";

const DEFAULT_MD = `# Milkdown Split Demo\n\n左が *Markdown ソース*、右が **WYSIWYG**（Milkdown）です。\n\n- 両側どちらで編集しても同期します\n- ソース側は入力中の負荷を避けるためデバウンスで反映します\n\n## Code\n\n\`\`\`ts\nexport const hello = (name: string) => \`Hello, \${name}\`\n\`\`\`\n`;

type Props = {
  initialMarkdown?: string;
  debounceMs?: number;
};

type Stops = {
  sourceStops: number[];
  editorStops: number[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const smoothScrollTo = (
  el: HTMLElement,
  target: number,
  cancelRef: React.MutableRefObject<number | null>,
  durationMs = 140,
) => {
  if (cancelRef.current != null) {
    cancelAnimationFrame(cancelRef.current);
    cancelRef.current = null;
  }

  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const to = clamp(target, 0, max);
  const start = el.scrollTop;
  const delta = to - start;
  if (Math.abs(delta) < 0.5) return;

  const startAt = performance.now();

  const step = (now: number) => {
    const p = clamp((now - startAt) / durationMs, 0, 1);
    const e = easeOutCubic(p);
    el.scrollTop = start + delta * e;
    if (p < 1) cancelRef.current = requestAnimationFrame(step);
  };

  cancelRef.current = requestAnimationFrame(step);
};

type PendingScroll = {
  el: HTMLElement;
  target: number;
};

type PendingScrolls = {
  source?: PendingScroll;
  editor?: PendingScroll;
};

const resampleStops = (stops: number[], nextLen: number): number[] => {
  if (nextLen <= 0) return [];
  if (stops.length === nextLen) return stops;
  if (stops.length === 0) return Array.from({ length: nextLen }, () => 0);
  if (stops.length === 1)
    return Array.from({ length: nextLen }, () => stops[0]);

  const maxIndex = stops.length - 1;
  return Array.from({ length: nextLen }, (_unused, j) => {
    const f = nextLen === 1 ? 0 : j / (nextLen - 1);
    const x = f * maxIndex;
    const i = Math.floor(x);
    const t = x - i;
    const a = stops[i] ?? stops[maxIndex];
    const b = stops[Math.min(i + 1, maxIndex)] ?? stops[maxIndex];
    return a + (b - a) * t;
  });
};

const mapScrollTop = (
  fromTop: number,
  fromStops: number[],
  toStops: number[],
  fromMax: number,
  toMax: number,
) => {
  if (fromMax <= 0 || toMax <= 0) {
    const ratio = fromMax <= 0 ? 0 : clamp(fromTop / fromMax, 0, 1);
    return ratio * toMax;
  }

  const from = fromStops.length >= 2 ? fromStops : [0, fromMax];
  const to = toStops.length >= 2 ? toStops : [0, toMax];
  const len = Math.max(2, Math.min(from.length, to.length));
  const fStops = resampleStops(from, len);
  const tStops = resampleStops(to, len);

  const top = clamp(fromTop, 0, fromMax);

  let i = 0;
  while (i < len - 2 && top > fStops[i + 1]) i++;

  const a = fStops[i];
  const b = fStops[i + 1];
  const t = b === a ? 0 : clamp((top - a) / (b - a), 0, 1);
  return tStops[i] + (tStops[i + 1] - tStops[i]) * t;
};

const getLineHeightPx = (el: HTMLTextAreaElement): number => {
  const s = getComputedStyle(el);
  const lh = parseFloat(s.lineHeight);
  if (!Number.isFinite(lh)) return 20;
  if (lh === 0) return 20;
  return lh;
};

const extractHeadingLineStarts = (markdown: string): number[] => {
  const lines = markdown.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i] ?? "")) starts.push(i);
  }
  return starts;
};

const extractBlockLineStarts = (markdown: string): number[] => {
  const lines = markdown.split("\n");
  const starts: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    const prev = (lines[i - 1] ?? "").trim();
    const cur = (lines[i] ?? "").trim();
    if (prev === "" && cur !== "") starts.push(i);
  }
  return Array.from(new Set(starts)).sort((a, b) => a - b);
};

const InnerEditor: React.FC<Props> = ({
  initialMarkdown = DEFAULT_MD,
  debounceMs = 250,
}) => {
  const initial = useMemo(() => initialMarkdown, [initialMarkdown]);

  const [markdown, setMarkdown] = useState<string>(initial);

  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const wysiwygScrollRef = useRef<HTMLDivElement | null>(null);

  const stopsRef = useRef<Stops>({ sourceStops: [], editorStops: [] });
  const recomputeRafRef = useRef<number | null>(null);

  const pendingScrollsRef = useRef<PendingScrolls>({});
  const syncRafRef = useRef<number | null>(null);

  const syncLockRef = useRef<"source" | "editor" | null>(null);
  const syncLockUntilRef = useRef(0);

  const sourceSnapTimerRef = useRef<number | null>(null);
  const editorSnapTimerRef = useRef<number | null>(null);
  const sourceSnapAnimRef = useRef<number | null>(null);
  const editorSnapAnimRef = useRef<number | null>(null);

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

          ctx.get(listenerCtx).mounted(() => {
            queueMicrotask(() => scheduleRecomputeStops());
          });

          ctx.get(listenerCtx).updated(() => {
            scheduleRecomputeStops();
          });
        })
        .use(commonmark)
        .use(listener);
    };
  }, [initial]);

  const { get } = useEditor(editorFactory);

  const getEditorView = (): ProseLikeView | null => {
    const editor = get();
    if (!editor) return null;
    try {
      return editor.action((ctx) => ctx.get(editorViewCtx)) as ProseLikeView;
    } catch {
      return null;
    }
  };

  const recomputeStops = () => {
    const sourceEl = sourceRef.current;
    const editorScrollEl = wysiwygScrollRef.current;
    const view = getEditorView();
    if (!sourceEl || !editorScrollEl || !view) return;

    const sourceMax = Math.max(0, sourceEl.scrollHeight - sourceEl.clientHeight);
    const editorMax = Math.max(
      0,
      editorScrollEl.scrollHeight - editorScrollEl.clientHeight,
    );

    const lineHeight = getLineHeightPx(sourceEl);
    const headingLines = extractHeadingLineStarts(markdownRef.current);
    const blockLines = extractBlockLineStarts(markdownRef.current);
    const sourceLines = headingLines.length >= 2 ? headingLines : blockLines;

    const sourceStops = [
      0,
      ...sourceLines.map((line) => clamp(line * lineHeight, 0, sourceMax)),
      sourceMax,
    ]
      .filter((x, idx, arr) => idx === 0 || x >= (arr[idx - 1] ?? 0))
      .reduce<number[]>((acc, x) => {
        if (acc.length === 0 || Math.abs(x - acc[acc.length - 1]!) > 0.5)
          acc.push(x);
        return acc;
      }, []);

    const editorRect = editorScrollEl.getBoundingClientRect();
    const editorScrollTop = editorScrollEl.scrollTop;

    const editorHeadingStops: number[] = [];
    view.state.doc.descendants((node: any, pos: number) => {
      if (node.type.name !== "heading") return;
      try {
        const coords = view.coordsAtPos(pos + 1);
        const top = coords.top - editorRect.top + editorScrollTop;
        editorHeadingStops.push(clamp(top, 0, editorMax));
      } catch {
        // ignore
      }
    });

    const editorBlockStops: number[] = [];
    view.state.doc.forEach((_node: any, offset: number) => {
      try {
        const coords = view.coordsAtPos(offset + 1);
        const top = coords.top - editorRect.top + editorScrollTop;
        editorBlockStops.push(clamp(top, 0, editorMax));
      } catch {
        // ignore
      }
    });

    const editorAnchorsRaw =
      editorHeadingStops.length >= 2 ? editorHeadingStops : editorBlockStops;

    const editorStops = [0, ...editorAnchorsRaw, editorMax]
      .sort((a, b) => a - b)
      .reduce<number[]>((acc, x) => {
        if (acc.length === 0 || Math.abs(x - acc[acc.length - 1]!) > 0.5)
          acc.push(x);
        return acc;
      }, []);

    stopsRef.current = { sourceStops, editorStops };
  };

  const scheduleRecomputeStops = () => {
    if (recomputeRafRef.current != null) return;
    recomputeRafRef.current = requestAnimationFrame(() => {
      recomputeRafRef.current = null;
      recomputeStops();
    });
  };

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

      scheduleRecomputeStops();
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [debounceMs, get, markdown]);

  useEffect(() => {
    scheduleRecomputeStops();
  }, [markdown]);

  useEffect(() => {
    const onResize = () => scheduleRecomputeStops();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const sourceEl = sourceRef.current;
    const editorEl = wysiwygScrollRef.current;
    if (!sourceEl || !editorEl) return;

    const ro = new ResizeObserver(() => {
      scheduleRecomputeStops();
    });
    ro.observe(sourceEl);
    ro.observe(editorEl);

    return () => ro.disconnect();
  }, []);

  const acquireLock = (who: "source" | "editor", ms = 240) => {
    syncLockRef.current = who;
    syncLockUntilRef.current = performance.now() + ms;
  };

  const isLockedByOther = (who: "source" | "editor") => {
    const locked = syncLockRef.current;
    const until = syncLockUntilRef.current;
    if (!locked) return false;
    if (performance.now() > until) {
      syncLockRef.current = null;
      return false;
    }
    return locked !== who;
  };

  const scheduleScrollTop = (
    key: "source" | "editor",
    el: HTMLElement,
    target: number,
  ) => {
    pendingScrollsRef.current[key] = { el, target };
    if (syncRafRef.current != null) return;
    syncRafRef.current = requestAnimationFrame(() => {
      syncRafRef.current = null;
      const pending = pendingScrollsRef.current;
      pendingScrollsRef.current = {};

      const apply = (p?: PendingScroll) => {
        if (!p) return;
        const max = Math.max(0, p.el.scrollHeight - p.el.clientHeight);
        const next = clamp(p.target, 0, max);
        if (Math.abs(p.el.scrollTop - next) > 0.5) p.el.scrollTop = next;
      };

      apply(pending.source);
      apply(pending.editor);
    });
  };

  const clearSnapTimers = () => {
    if (sourceSnapTimerRef.current != null) {
      window.clearTimeout(sourceSnapTimerRef.current);
      sourceSnapTimerRef.current = null;
    }
    if (editorSnapTimerRef.current != null) {
      window.clearTimeout(editorSnapTimerRef.current);
      editorSnapTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearSnapTimers();
      if (sourceSnapAnimRef.current != null)
        cancelAnimationFrame(sourceSnapAnimRef.current);
      if (editorSnapAnimRef.current != null)
        cancelAnimationFrame(editorSnapAnimRef.current);
    };
  }, []);

  const scheduleSnap = (who: "source" | "editor") => {
    const timerRef = who === "source" ? sourceSnapTimerRef : editorSnapTimerRef;

    if (timerRef.current != null) window.clearTimeout(timerRef.current);

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (isLockedByOther(who)) return;

      const sourceEl = sourceRef.current;
      const editorEl = wysiwygScrollRef.current;
      if (!sourceEl || !editorEl) return;

      const sourceMax = Math.max(
        0,
        sourceEl.scrollHeight - sourceEl.clientHeight,
      );
      const editorMax = Math.max(
        0,
        editorEl.scrollHeight - editorEl.clientHeight,
      );
      const { sourceStops, editorStops } = stopsRef.current;

      if (who === "source") {
        const target = mapScrollTop(
          sourceEl.scrollTop,
          sourceStops,
          editorStops,
          sourceMax,
          editorMax,
        );
        acquireLock("source", 360);
        smoothScrollTo(editorEl, target, editorSnapAnimRef, 160);
      } else {
        const target = mapScrollTop(
          editorEl.scrollTop,
          editorStops,
          sourceStops,
          editorMax,
          sourceMax,
        );
        acquireLock("editor", 360);
        smoothScrollTo(sourceEl, target, sourceSnapAnimRef, 160);
      }
    }, 120);
  };

  const syncSourceToEditor = () => {
    if (isLockedByOther("source")) return;
    const sourceEl = sourceRef.current;
    const editorEl = wysiwygScrollRef.current;
    if (!sourceEl || !editorEl) return;

    const sourceMax = Math.max(0, sourceEl.scrollHeight - sourceEl.clientHeight);
    const editorMax = Math.max(0, editorEl.scrollHeight - editorEl.clientHeight);
    const { sourceStops, editorStops } = stopsRef.current;

    const target = mapScrollTop(
      sourceEl.scrollTop,
      sourceStops,
      editorStops,
      sourceMax,
      editorMax,
    );

    acquireLock("source", 260);
    scheduleScrollTop("editor", editorEl, target);
    scheduleSnap("source");
  };

  const syncEditorToSource = () => {
    if (isLockedByOther("editor")) return;
    const sourceEl = sourceRef.current;
    const editorEl = wysiwygScrollRef.current;
    if (!sourceEl || !editorEl) return;

    const sourceMax = Math.max(0, sourceEl.scrollHeight - sourceEl.clientHeight);
    const editorMax = Math.max(0, editorEl.scrollHeight - editorEl.clientHeight);
    const { sourceStops, editorStops } = stopsRef.current;

    const target = mapScrollTop(
      editorEl.scrollTop,
      editorStops,
      sourceStops,
      editorMax,
      sourceMax,
    );

    acquireLock("editor", 260);
    scheduleScrollTop("source", sourceEl, target);
    scheduleSnap("editor");
  };

  return (
    <div className="split">
      <section className="pane">
        <div className="pane-header">
          <div className="pane-title">Markdown</div>
        </div>
        <div className="pane-body">
          <textarea
            className="source"
            ref={sourceRef}
            value={markdown}
            onChange={(e) => setMarkdown(e.currentTarget.value)}
            onScroll={syncSourceToEditor}
            spellCheck={false}
          />
        </div>
      </section>

      <section className="pane">
        <div className="pane-header">
          <div className="pane-title">WYSIWYG</div>
        </div>
        <div
          className="pane-body"
          ref={wysiwygScrollRef}
          onScroll={syncEditorToSource}
        >
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
