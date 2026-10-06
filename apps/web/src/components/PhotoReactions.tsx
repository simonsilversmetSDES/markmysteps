import { useCallback, useEffect, useMemo, useState } from 'react';
import './photoreactions.css';

/** The five a photo can get, in the order the picker shows them. */
export const REACTIONS = [
  { kind: 'heart', emoji: '❤️', label: 'Hartje' },
  { kind: 'laugh', emoji: '😂', label: 'Grappig' },
  { kind: 'wow', emoji: '😮', label: 'Wauw' },
  { kind: 'love', emoji: '😍', label: 'Prachtig' },
  { kind: 'clap', emoji: '👏', label: 'Applaus' },
] as const;

const EMOJI: Record<string, string> = Object.fromEntries(REACTIONS.map((r) => [r.kind, r.emoji]));

/** Targets: a photo by its media id, a comment as `c:<comment id>`. */
export interface ReactionsView {
  counts: { target: string; kind: string; count: number }[];
  mine: Record<string, string>;
  names?: Record<string, { kind: string; name: string }[]>;
}

export interface ReactionsAdapter {
  /** How many of each on a photo or comment, most first. */
  summary: (target: string) => { kind: string; count: number }[];
  /** The viewer's own pick. */
  mine: (target: string) => string | null;
  /** Who reacted, when the server tells (the app, not the share page). */
  names: (target: string) => { kind: string; name: string }[];
  set: (target: string, kind: string | null) => Promise<void>;
}

/** A comment as a reaction target. */
export const commentTarget = (commentId: string) => `c:${commentId}`;

/** This browser's key on the share page: who a visitor is, for their hearts. */
export function reactorKey(): string {
  try {
    const stored = localStorage.getItem('mms.reactor');
    if (stored) return stored;
  } catch {
    // Falls through to a key for this visit only.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const key = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  try {
    localStorage.setItem('mms.reactor', key);
  } catch {
    // A private window: the hearts last as long as the visit.
  }
  return key;
}

/**
 * The trip's reactions, kept in state and changed optimistically: a tap shows
 * at once, and is put back if the server says no.
 */
export function useReactions(
  load: () => Promise<ReactionsView>,
  put: (target: string, kind: string | null) => Promise<void>,
): ReactionsAdapter {
  const [view, setView] = useState<ReactionsView>({ counts: [], mine: {} });

  useEffect(() => {
    load().then(setView).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byMedia = useMemo(() => {
    const map = new Map<string, { kind: string; count: number }[]>();
    for (const c of view.counts) {
      if (c.count <= 0) continue;
      const list = map.get(c.target) ?? [];
      list.push({ kind: c.kind, count: c.count });
      map.set(c.target, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.count - a.count);
    return map;
  }, [view.counts]);

  const set = useCallback(
    async (target: string, kind: string | null) => {
      const before = view;
      setView((v) => applyPick(v, target, kind));
      try {
        await put(target, kind);
      } catch {
        setView(before);
      }
    },
    [view, put],
  );

  return useMemo(
    () => ({
      summary: (id) => byMedia.get(id) ?? [],
      mine: (id) => view.mine[id] ?? null,
      names: (id) => view.names?.[id] ?? [],
      set,
    }),
    [byMedia, view, set],
  );
}

/** The counts as they are after one person swaps, adds or drops their pick. */
function applyPick(v: ReactionsView, target: string, kind: string | null): ReactionsView {
  const old = v.mine[target] ?? null;
  const counts = v.counts.map((c) => ({ ...c }));
  const bump = (k: string, by: number) => {
    const row = counts.find((c) => c.target === target && c.kind === k);
    if (row) row.count += by;
    else if (by > 0) counts.push({ target, kind: k, count: by });
  };
  if (old) bump(old, -1);
  if (kind) bump(kind, 1);
  const mine = { ...v.mine };
  if (kind) mine[target] = kind;
  else delete mine[target];
  return { ...v, counts, mine };
}

/** On a grid photo: the most-given emoji and how many in all. */
export function ReactionBadge({ summary }: { summary: { kind: string; count: number }[] }) {
  if (summary.length === 0) return null;
  const total = summary.reduce((sum, r) => sum + r.count, 0);
  return (
    <span className="reaction-badge" aria-label={`${total} reacties met emoji`}>
      {summary.slice(0, 2).map((r) => (
        <span key={r.kind}>{EMOJI[r.kind]}</span>
      ))}
      <span className="reaction-badge-count">{total}</span>
    </span>
  );
}

/**
 * In the viewer, bottom left: the button that opens the five, and what the
 * photo already got. Tapping your own pick again takes it away.
 */
export function ReactionBar({ mediaId, adapter }: { mediaId: string; adapter: ReactionsAdapter }) {
  const [open, setOpen] = useState(false);
  const mine = adapter.mine(mediaId);
  const summary = adapter.summary(mediaId);
  const names = adapter.names(mediaId);
  const total = summary.reduce((sum, r) => sum + r.count, 0);

  // Another photo: the picker closes rather than hovering over the wrong one.
  useEffect(() => setOpen(false), [mediaId]);

  const pick = (kind: string) => {
    setOpen(false);
    void adapter.set(mediaId, kind === mine ? null : kind);
  };

  return (
    <div className="reaction-bar" onClick={(e) => e.stopPropagation()}>
      {open && (
        <div className="reaction-picker" role="menu">
          {REACTIONS.map((r) => (
            <button
              key={r.kind}
              type="button"
              role="menuitem"
              aria-label={r.label}
              title={r.label}
              className={mine === r.kind ? 'on' : ''}
              onClick={() => pick(r.kind)}
            >
              {r.emoji}
            </button>
          ))}
          {names.length > 0 && (
            <p className="reaction-names">
              {names.map((n) => `${EMOJI[n.kind] ?? ''} ${n.name}`).join(' · ')}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className={`reaction-toggle ${mine ? 'has' : ''}`}
        aria-label="Reageer met een emoji"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {mine ? (
          <span className="reaction-toggle-emoji">{EMOJI[mine]}</span>
        ) : (
          // Words, not a hollow heart: it has to read as something to tap.
          <span className="reaction-toggle-label">Vind ik leuk</span>
        )}
        {total > 0 && (
          <span className="reaction-toggle-summary">
            {summary
              .filter((r) => r.kind !== mine)
              .slice(0, 2)
              .map((r) => EMOJI[r.kind])
              .join('')}
            {total}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * Under a comment: what it got, and a small button that opens the five in
 * the row itself (a popover would be clipped by the scrolling list).
 */
export function CommentReactions({ target, adapter }: { target: string; adapter: ReactionsAdapter }) {
  const [open, setOpen] = useState(false);
  const mine = adapter.mine(target);
  const summary = adapter.summary(target);
  const names = adapter.names(target);

  const pick = (kind: string) => {
    setOpen(false);
    void adapter.set(target, kind === mine ? null : kind);
  };

  if (open) {
    return (
      <div className="comment-reactions picking" role="menu">
        {REACTIONS.map((r) => (
          <button
            key={r.kind}
            type="button"
            role="menuitem"
            aria-label={r.label}
            title={r.label}
            className={mine === r.kind ? 'on' : ''}
            onClick={() => pick(r.kind)}
          >
            {r.emoji}
          </button>
        ))}
        <button
          type="button"
          className="comment-reactions-cancel"
          aria-label="Sluiten"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="comment-reactions">
      {summary.map((r) => (
        <button
          key={r.kind}
          type="button"
          className={`comment-reaction-chip ${mine === r.kind ? 'on' : ''}`}
          title={names
            .filter((n) => n.kind === r.kind)
            .map((n) => n.name)
            .join(', ')}
          // A tap on a chip gives (or takes back) that same one.
          onClick={() => pick(r.kind)}
        >
          {EMOJI[r.kind]} {r.count}
        </button>
      ))}
      <button
        type="button"
        className="comment-reactions-add"
        aria-label="Reageer met een emoji"
        onClick={() => setOpen(true)}
      >
        {summary.length === 0 ? 'Vind ik leuk' : '+'}
      </button>
    </div>
  );
}
