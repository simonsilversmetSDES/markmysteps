import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { confirmModal } from './confirm';
import { Icon } from './Icon';
import './visitorspanel.css';

interface Visitor {
  id: string;
  name: string;
  phone: string;
  subscribed: boolean;
  createdAt: string;
}

interface Overview {
  visitors: Visitor[];
  newPhotos: number;
  lastUpdateSentAt: string | null;
  whatsapp: { state: string; number: string | null };
}

const when = new Intl.DateTimeFormat('nl-BE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * The people at home who left their number on the share page, and the button
 * that tells them there are new photos. Nothing goes out on its own: the
 * travellers decide when an update is worth a message.
 */
export function VisitorsPanel({ tripId }: { tripId: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Overview>(`/trips/${tripId}/visitors`)
      .then(setData)
      .catch(() => setData(null));
  }, [tripId]);

  useEffect(load, [load]);

  if (!data) return null;

  const subscribed = data.visitors.filter((v) => v.subscribed);
  const linked = data.whatsapp.state === 'WORKING';

  async function sendUpdate() {
    if (subscribed.length === 0 || busy) return;
    const ok = await confirmModal({
      title: 'Update versturen?',
      body: `${subscribed.length === 1 ? '1 persoon krijgt' : `${subscribed.length} personen krijgen`} een WhatsApp-bericht${
        data!.newPhotos > 0
          ? ` over ${data!.newPhotos === 1 ? '1 nieuwe foto' : `${data!.newPhotos} nieuwe foto's`}`
          : ''
      }.`,
      confirmLabel: 'Versturen',
    });
    if (!ok) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await api<{ queued: number }>(`/trips/${tripId}/visitors/update`, {
        method: 'POST',
        body: message.trim() ? { message: message.trim() } : {},
      });
      setMessage('');
      setNote(
        res.queued === 1
          ? 'Verstuurd naar 1 persoon.'
          : `Wordt verstuurd naar ${res.queued} personen (een paar seconden per bericht).`,
      );
      load();
    } catch {
      setNote('Versturen is niet gelukt.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: Visitor) {
    const ok = await confirmModal({
      title: `${v.name} verwijderen?`,
      body: 'Naam en nummer worden gewist; deze persoon krijgt geen updates meer.',
      confirmLabel: 'Verwijderen',
      danger: true,
    });
    if (!ok) return;
    await api(`/trips/${tripId}/visitors/${v.id}`, { method: 'DELETE' }).catch(() => undefined);
    load();
  }

  return (
    <section className="visitors-panel">
      <h2 className="trip-side-heading">WhatsApp-updates</h2>
      <p className="muted visitors-hint">
        Wie op de deellink zijn naam en gsm-nummer achterliet. Zij krijgen alleen een bericht als
        jullie op de knop drukken, en een antwoord op hun eigen reactie.
      </p>

      {!linked && (
        <p className="visitors-warn">
          <Icon name="bell" size={14} />
          WhatsApp is nog niet gekoppeld: berichten worden niet verstuurd. Koppel het in
          Instellingen → Diensten.
        </p>
      )}

      {data.visitors.length === 0 ? (
        <p className="muted visitors-empty">Nog niemand ingeschreven.</p>
      ) : (
        <ul className="visitors-list">
          {data.visitors.map((v) => (
            <li key={v.id} className={v.subscribed ? '' : 'off'}>
              <span className="visitors-name">{v.name}</span>
              <a className="visitors-phone" href={`tel:${v.phone}`}>
                {v.phone}
              </a>
              {!v.subscribed && <span className="visitors-off">afgemeld</span>}
              <button
                type="button"
                className="visitors-remove"
                aria-label={`${v.name} verwijderen`}
                onClick={() => void remove(v)}
              >
                <Icon name="trash" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="visitors-update">
        <p className="visitors-count">
          {data.newPhotos === 0
            ? 'Geen nieuwe foto’s'
            : data.newPhotos === 1
              ? '1 nieuwe foto'
              : `${data.newPhotos} nieuwe foto’s`}
          {data.lastUpdateSentAt
            ? ` sinds de vorige update (${when.format(new Date(data.lastUpdateSentAt))})`
            : ' (nog geen update verstuurd)'}
        </p>
        <textarea
          rows={2}
          maxLength={1000}
          placeholder="Persoonlijk berichtje erbij (optioneel)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || subscribed.length === 0}
          onClick={() => void sendUpdate()}
        >
          {busy
            ? 'Versturen…'
            : subscribed.length === 0
              ? 'Nog niemand om te verwittigen'
              : `Update versturen naar ${subscribed.length}`}
        </button>
        {note && (
          <p className="visitors-note" role="status">
            {note}
          </p>
        )}
      </div>
    </section>
  );
}
