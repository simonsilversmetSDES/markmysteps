import { FormEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import './visitorsignup.css';

export interface VisitorInfo {
  token: string;
  name: string;
}

const key = (slug: string) => `mms.visitor.${slug}`;
const askedKey = (slug: string) => `mms.visitorAsked.${slug}`;

/** The visitor this browser signed up as on this link, if it did. */
export function storedVisitor(slug: string): VisitorInfo | null {
  try {
    const raw = localStorage.getItem(key(slug));
    return raw ? (JSON.parse(raw) as VisitorInfo) : null;
  } catch {
    return null;
  }
}

export function storeVisitor(slug: string, visitor: VisitorInfo | null): void {
  try {
    if (visitor) localStorage.setItem(key(slug), JSON.stringify(visitor));
    else localStorage.removeItem(key(slug));
  } catch {
    // Private window: they are asked again next visit, which is fine.
  }
}

/** Whether the card was already answered (either way) in this browser. */
export function alreadyAsked(slug: string): boolean {
  try {
    return localStorage.getItem(askedKey(slug)) === '1';
  } catch {
    return false;
  }
}

function markAsked(slug: string): void {
  try {
    localStorage.setItem(askedKey(slug), '1');
  } catch {
    // See above.
  }
}

/**
 * "Want updates from Simon and Jozefien?" — the card a visitor gets on
 * opening a share link. Optional: "no thanks" shows them the trip all the
 * same, and the button at the bottom of the page brings it back.
 */
export function VisitorSignup({
  slug,
  token,
  hosts,
  onDone,
}: {
  slug: string;
  token: string;
  hosts: string;
  onDone: (visitor: VisitorInfo | null) => void;
}) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('mms.commentName') ?? '';
    } catch {
      return '';
    }
  });
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !phone.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/share/${slug}/visitor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-share-token': token },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() }),
      });
      if (!res.ok) {
        setError(
          res.status === 400
            ? 'Dat gsm-nummer klopt niet helemaal. Bijvoorbeeld: 0471 12 34 56'
            : 'Inschrijven is niet gelukt. Probeer het zo opnieuw.',
        );
        return;
      }
      const body = (await res.json()) as { token: string; name: string };
      const visitor = { token: body.token, name: body.name };
      storeVisitor(slug, visitor);
      try {
        localStorage.setItem('mms.commentName', body.name);
      } catch {
        // Only a convenience.
      }
      markAsked(slug);
      onDone(visitor);
    } catch {
      setError('Inschrijven is niet gelukt. Probeer het zo opnieuw.');
    } finally {
      setBusy(false);
    }
  }

  function decline() {
    markAsked(slug);
    onDone(null);
  }

  const from = hosts || 'de reizigers';

  return createPortal(
    <div className="visitor-signup-backdrop" onClick={decline}>
      <form
        className="visitor-signup"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        aria-labelledby="visitor-signup-title"
      >
        <button type="button" className="visitor-signup-close" aria-label="Sluiten" onClick={decline}>
          <Icon name="close" size={18} />
        </button>
        <h2 id="visitor-signup-title">Wil je updates ontvangen van {from}?</h2>
        <p>Vul dan je naam en gsm-nummer in.</p>
        <label>
          <span>Naam</span>
          <input
            type="text"
            autoComplete="name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span>Gsm-nummer</span>
          <input
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="0471 12 34 56"
            maxLength={30}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <p className="visitor-signup-small">
          Je krijgt een WhatsApp-bericht als er nieuwe foto's zijn of als iemand antwoordt op je
          reactie. Je nummer is alleen zichtbaar voor {from}. Afmelden kan altijd, met de link in
          elk bericht.
        </p>
        {error && (
          <p className="visitor-signup-error" role="alert">
            {error}
          </p>
        )}
        <div className="visitor-signup-actions">
          <button type="button" className="visitor-signup-no" onClick={decline}>
            Nee, bedankt
          </button>
          <button
            type="submit"
            className="visitor-signup-yes"
            disabled={busy || !name.trim() || !phone.trim()}
          >
            {busy ? 'Even geduld…' : 'Hou me op de hoogte'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
