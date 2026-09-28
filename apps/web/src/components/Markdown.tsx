import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './markdown.css';

/**
 * Markdown the traveller wrote, for the people reading along: the trip's
 * general info (flights, hotels, the plan) and a stop's notes.
 *
 * It renders to React elements, never to an HTML string, and raw HTML in the
 * text is dropped rather than passed through (`skipHtml`, no rehype-raw). The
 * default URL transform already blanks `javascript:` and other unsafe links.
 * What is left is text, tables, lists and links — the share page is public,
 * and that is all a trip description needs.
 */
const components: Components = {
  // Out to Google Maps or a booking, and back to the trip in the other tab.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // A four-column table is wider than a phone: it scrolls in its own box
  // instead of pushing the whole page sideways.
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap">
      <table {...props} />
    </div>
  ),
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
