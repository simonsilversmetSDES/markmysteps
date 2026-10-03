import { FormEvent, useEffect, useRef, useState } from 'react';
import type { PhotoComment } from '../api/types';
import { Icon } from './Icon';
import './photocomments.css';

/**
 * What a viewer needs to show and write comments. The share page and the app
 * each hand in their own: the share page asks visitors for a name and talks to
 * the link's endpoints, the app knows who you are and may take comments away.
 */
export interface PhotoCommentsAdapter {
  /** Every comment on the trip, grouped by photo. */
  byMedia: Map<string, PhotoComment[]>;
  /** A visitor has no account, so they type the name the comment goes under. */
  askName: boolean;
  post: (mediaId: string, body: string, name?: string) => Promise<void>;
  remove?: (comment: PhotoComment) => Promise<void>;
}

const NAME_KEY = 'mms.commentName';

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // A private window: the name is simply asked for again next time.
  }
}

const when = new Intl.DateTimeFormat('nl-BE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** The flag on a photo in the grid that has comments under it. */
export function CommentFlag({ count, onOpen }: { count: number; onOpen?: () => void }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className="comment-flag"
      aria-label={count === 1 ? '1 reactie' : `${count} reacties`}
      onClick={(e) => {
        // Straight to the conversation, not just to the photo.
        e.stopPropagation();
        onOpen?.();
      }}
    >
      <Icon name="comment" size={13} />
      {count}
    </button>
  );
}

/** The comments under one photo in the viewer, with the box to add one. */
export function PhotoCommentsPanel({
  mediaId,
  adapter,
  onClose,
}: {
  mediaId: string;
  adapter: PhotoCommentsAdapter;
  onClose: () => void;
}) {
  const comments = adapter.byMedia.get(mediaId) ?? [];
  const [name, setName] = useState(rememberedName);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Another photo, another conversation: a half-written comment stays with
  // the photo it was meant for by not following you to the next one.
  useEffect(() => {
    setBody('');
    setError(null);
  }, [mediaId]);

  // The newest is at the bottom, next to the box you just wrote it in.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [comments.length, mediaId]);

  const canSend = body.trim().length > 0 && (!adapter.askName || name.trim().length > 0) && !busy;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const typed = adapter.askName ? name.trim() : undefined;
      await adapter.post(mediaId, body.trim(), typed);
      if (typed) rememberName(typed);
      setBody('');
    } catch (err) {
      setError(
        err instanceof Error && err.message === '429'
          ? 'Even geduld, je reageert wat snel. Probeer het zo opnieuw.'
          : 'Je reactie is niet verstuurd. Probeer het opnieuw.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(comment: PhotoComment) {
    if (!adapter.remove) return;
    try {
      await adapter.remove(comment);
    } catch {
      setError('Verwijderen is niet gelukt.');
    }
  }

  return (
    <section
      className="photo-comments"
      aria-label="Reacties"
      // The viewer closes on a tap anywhere outside the photo; this is not
      // outside the photo as far as anybody reading it is concerned.
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <header className="photo-comments-head">
        <strong>
          {comments.length === 0
            ? 'Reacties'
            : comments.length === 1
              ? '1 reactie'
              : `${comments.length} reacties`}
        </strong>
        <button type="button" aria-label="Reacties sluiten" onClick={onClose}>
          <Icon name="chevron-down" size={20} />
        </button>
      </header>

      {comments.length === 0 ? (
        <p className="photo-comments-empty">Nog geen reacties. Schrijf de eerste.</p>
      ) : (
        <ol className="photo-comments-list" ref={listRef}>
          {comments.map((c) => (
            <li key={c.id}>
              <div className="photo-comments-meta">
                <span className="photo-comments-name">{c.authorName}</span>
                {c.traveller && <span className="photo-comments-badge">reiziger</span>}
                <time dateTime={c.createdAt}>{when.format(new Date(c.createdAt))}</time>
                {c.canDelete && adapter.remove && (
                  <button
                    type="button"
                    className="photo-comments-delete"
                    aria-label="Reactie verwijderen"
                    onClick={() => void remove(c)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
              <p className="photo-comments-body">{c.body}</p>
            </li>
          ))}
        </ol>
      )}

      <form className="photo-comments-form" onSubmit={submit}>
        {adapter.askName && (
          <input
            type="text"
            className="photo-comments-name-input"
            placeholder="Je naam"
            autoComplete="name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <div className="photo-comments-compose">
          <textarea
            placeholder="Schrijf een reactie…"
            rows={1}
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line — as in any chat.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button type="submit" disabled={!canSend} aria-label="Versturen">
            {busy ? '…' : 'Plaats'}
          </button>
        </div>
        {error && (
          <p className="photo-comments-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
