import React, { useMemo, useEffect, useRef } from 'react';
import { marked } from 'marked';
import 'katex/dist/katex.min.css';
import { escapeHtml, sanitizeHtml } from '../sanitize';
import { copyToClipboard } from '../toolDisplay';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Static, trusted markup for the copy button (the lucide "copy" and "check" strokes).
const svg = (body: string) =>
  `<svg class="icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const COPY_ICON = svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
const CHECK_ICON = svg('<polyline points="20 6 9 17 4 12"/>');

function setCopyLabel(btn: HTMLButtonElement, copied: boolean) {
  btn.innerHTML = `${copied ? CHECK_ICON : COPY_ICON}<span>${copied ? 'Copied' : 'Copy'}</span>`;
  btn.classList.toggle('is-copied', copied);
  btn.setAttribute('aria-label', copied ? 'Copied' : 'Copy code');
}

/** Language from marked's `language-xxx` class on the fenced block's <code>. */
function languageOf(code: Element | null): string | null {
  const cls = code?.className.match(/(?:^|\s)language-([\w+#.-]+)/);
  return cls ? cls[1] : null;
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const rendered = useMemo(() => {
    if (!content) return { html: '', math: new Map<string, { source: string; display: boolean }>() };
    const math = new Map<string, { source: string; display: boolean }>();
    const code = new Map<string, string>();
    const nonce = Math.random().toString(36).slice(2);
    let source = content.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)|`+[^`\n]*`+/g, (match) => {
      const token = `CODEPITCODE${nonce}${code.size}END`;
      code.set(token, match);
      return token;
    });
    // Keep math out of the Markdown parser; KaTeX markup is created only after the
    // untrusted Markdown has passed through the HTML allowlist sanitizer.
    source = source.replace(/(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (match, display, inline) => {
      const token = `CODEPITMATH${nonce}${math.size}END`;
      math.set(token, { source: (display ?? inline).trim(), display: display !== undefined });
      return token;
    });
    for (const [token, sourceCode] of code) source = source.replace(token, sourceCode);
    try {
      return {
        html: sanitizeHtml(marked.parse(source, {
          gfm: true,
          breaks: true,
        }) as string),
        math,
      };
    } catch (err) {
      console.error('Failed to parse markdown:', err);
      return { html: `<pre>${escapeHtml(content)}</pre>`, math: new Map() };
    }
  }, [content]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const timers: number[] = [];

    // Restore mathematical expressions as trusted KaTeX output after sanitizing source HTML.
    if (rendered.math.size) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes: Text[] = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
      for (const node of textNodes) {
        let value = node.textContent || '';
        if (![...rendered.math.keys()].some((token) => value.includes(token))) continue;
        const fragment = document.createDocumentFragment();
        while (value) {
          const match = [...rendered.math.keys()]
            .map((token) => ({ token, index: value.indexOf(token) }))
            .filter((entry) => entry.index >= 0)
            .sort((a, b) => a.index - b.index)[0];
          if (!match) {
            fragment.append(document.createTextNode(value));
            break;
          }
          if (match.index > 0) fragment.append(document.createTextNode(value.slice(0, match.index)));
          const equation = rendered.math.get(match.token)!;
          const mathEl = document.createElement(equation.display ? 'div' : 'span');
          mathEl.className = equation.display ? 'md-math md-math-display' : 'md-math';
          const renderEquation = async () => {
            try {
              katexPromise ??= import('katex');
              const katex = (await katexPromise).default;
              if (!mathEl.isConnected) return;
              mathEl.innerHTML = katex.renderToString(equation.source, {
              displayMode: equation.display,
              throwOnError: false,
              trust: false,
              output: 'htmlAndMathml',
              });
            } catch {
              mathEl.textContent = equation.source;
              mathEl.classList.add('is-error');
            }
          };
          fragment.append(mathEl);
          void renderEquation();
          value = value.slice(match.index + match.token.length);
        }
        node.replaceWith(fragment);
      }
    }

    // Links open in a new tab, without handing the page an opener.
    root.querySelectorAll('a').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });

    // Wide tables scroll inside their own box instead of stretching the column.
    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('md-table-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });

    // Code blocks get a frame: a language header when the fence names one, and a copy button.
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('md-code')) return;
      const code = pre.querySelector('code');
      const lang = languageOf(code);

      if (lang?.toLowerCase() === 'mermaid' && code) {
        renderMermaid(code.textContent || '', pre);
        return;
      }

      const frame = document.createElement('div');
      frame.className = `md-code${lang ? ' has-lang' : ''}`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-code-copy';
      btn.title = 'Copy code to clipboard';
      setCopyLabel(btn, false);
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const text = (code ? code.textContent || '' : pre.textContent || '').replace(/\n$/, '');
        if (await copyToClipboard(text)) {
          setCopyLabel(btn, true);
          timers.push(window.setTimeout(() => setCopyLabel(btn, false), 1800));
        }
      });

      pre.replaceWith(frame);
      if (lang) {
        const head = document.createElement('div');
        head.className = 'md-code-head';
        const label = document.createElement('span');
        label.className = 'md-code-lang';
        label.textContent = lang;
        head.append(label, btn);
        frame.append(head, pre);
      } else {
        frame.append(pre, btn);
      }
    });

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [rendered]);

  return (
    <div
      ref={containerRef}
      className={`prose markdown-content ${className}`.trim()}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
};

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;
let katexPromise: Promise<typeof import('katex')> | null = null;

/** Mermaid output is generated locally in strict mode, then pruned before adding SVG to the document. */
async function renderMermaid(source: string, pre: HTMLElement): Promise<void> {
  const parent = pre.parentElement;
  if (!parent || pre.dataset.mermaidRendering) return;
  pre.dataset.mermaidRendering = 'true';
  const wrapper = document.createElement('div');
  wrapper.className = 'md-mermaid';
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute('aria-label', 'Mermaid diagram');
  try {
    mermaidPromise ??= import('mermaid');
    const mermaid = (await mermaidPromise).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    const { svg } = await mermaid.render(`codepit-mermaid-${Math.random().toString(36).slice(2)}`, source);
    // Mermaid emits HTML-compatible SVG (including foreignObject for multiline labels),
    // so parse it in an HTML document to handle those nodes consistently across browsers.
    const parsed = new DOMParser().parseFromString(svg, 'text/html');
    const root = parsed.body.querySelector('svg');
    if (!root) throw new Error('Invalid Mermaid SVG');

    // Mermaid's strict mode disables HTML labels and interactions. Defensively remove
    // executable elements, event attributes, external references and CSS URL loads too.
    root.querySelectorAll('script, iframe, object, embed').forEach((el) => el.remove());
    root.querySelectorAll('foreignObject *').forEach((el) => {
      if (!['div', 'span', 'p', 'br', 'strong', 'em', 'b', 'i'].includes(el.localName)) el.replaceWith(...Array.from(el.childNodes));
    });
    [root, ...Array.from(root.querySelectorAll('*'))].forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || ((name === 'href' || name.endsWith(':href')) && value && !value.startsWith('#')) ||
            ((name === 'style' || name === 'filter') && /url\s*\(|expression\s*\(/i.test(value))) {
          el.removeAttribute(attr.name);
        }
      }
    });
    root.querySelectorAll('style').forEach((style) => {
      if (/@import|url\s*\(|expression\s*\(/i.test(style.textContent || '')) style.remove();
    });
    wrapper.append(document.importNode(root, true));
    pre.replaceWith(wrapper);
  } catch (err) {
    console.warn('Could not render Mermaid diagram:', err);
    wrapper.classList.add('md-mermaid-error');
    wrapper.setAttribute('role', 'note');
    const reason = err instanceof Error ? ` ${err.message}` : '';
    wrapper.textContent = `Could not render this Mermaid diagram.${reason} The source is shown below.`;
    pre.replaceWith(wrapper, pre);
  }
}
