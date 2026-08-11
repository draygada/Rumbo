import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Markdown.module.css';

/**
 * Renders untrusted LLM markdown output (tutor assistant answers).
 *
 * - GFM enabled (tables, strikethrough, task lists, autolinks).
 * - Raw HTML is deliberately NOT enabled (no rehype-raw): the input is
 *   untrusted model output, so we never let it inject HTML.
 * - Tolerates partial / incomplete markdown: answers stream in token by
 *   token, so this re-renders mid-syntax constantly. react-markdown handles
 *   that gracefully, and we add nothing here that assumes complete syntax.
 */
export default function Markdown({ children }: { children: string }) {
  const text = typeof children === 'string' ? children : String(children ?? '');

  return (
    <div className={styles.root}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
