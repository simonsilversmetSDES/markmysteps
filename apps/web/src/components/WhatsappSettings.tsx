import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError, getAccessToken, getServerBase } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface Mine {
  phone: string | null;
  available: boolean;
}

interface Status {
  state: string;
  number: string | null;
}

const STATE_LABEL: Record<string, string> = {
  DISABLED: 'Niet ingesteld op de server',
  UNREACHABLE: 'WhatsApp-dienst niet bereikbaar',
  STOPPED: 'Niet gekoppeld',
  STARTING: 'Bezig met opstarten…',
  SCAN_QR_CODE: 'Wacht op het scannen van de QR-code',
  WORKING: 'Gekoppeld',
  FAILED: 'Koppeling verbroken, koppel opnieuw',
};

/**
 * WhatsApp in the settings: your own number, where comments on your trips
 * reach you, and — for the admin — linking the account that sends.
 */
export function WhatsappSettings() {
  const { user } = useAuth();
  const [mine, setMine] = useState<Mine | null>(null);
  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Mine>('/whatsapp/me')
      .then((m) => {
        setMine(m);
        setPhone(m.phone ?? '');
      })
      .catch(() => undefined);
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(null);
    setError(null);
    try {
      const m = await api<Mine>('/whatsapp/me', {
        method: 'PUT',
        body: { phone: phone.trim() || null },
      });
      setMine(m);
      setPhone(m.phone ?? '');
      setSaved(m.phone ? `Opgeslagen: ${m.phone}` : 'Nummer verwijderd');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Opslaan is niet gelukt');
    }
  }

  if (!mine) return null;

  return (
    <section className="card settings-card">
      <h2>WhatsApp</h2>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="wa-phone">Jouw gsm-nummer voor meldingen</label>
          <input
            id="wa-phone"
            type="tel"
            inputMode="tel"
            placeholder="0471 12 34 56"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <span className="muted">
            Hier krijg je een bericht als iemand op de deelpagina reageert op een foto van je reis.
            Leeg laten: geen berichten.
          </span>
        </div>
        <div className="settings-actions">
          <button className="btn btn-primary">Opslaan</button>
        </div>
      </form>
      {saved && <p className="settings-ok">{saved}</p>}
      {error && <p className="error-text">{error}</p>}
      {user?.role === 'ADMIN' && <WhatsappLink canTest={Boolean(mine.phone)} />}
    </section>
  );
}

/** Linking the sending account: status, QR code, test, unlink. Admin only. */
function WhatsappLink({ canTest }: { canTest: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<Status>('/whatsapp/admin')
      .then(setStatus)
      .catch(() => setStatus({ state: 'UNREACHABLE', number: null }));
  }, []);

  useEffect(refresh, [refresh]);

  // Waiting on a scan: follow the state, and fetch a fresh code as WhatsApp
  // rotates it every twenty seconds.
  useEffect(() => {
    if (!status || !['SCAN_QR_CODE', 'STARTING'].includes(status.state)) {
      setQr((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      return;
    }
    let alive = true;
    const loadQr = async () => {
      if (status.state !== 'SCAN_QR_CODE') return;
      try {
        const token = getAccessToken();
        const res = await fetch(`${getServerBase()}/api/whatsapp/admin/qr`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok || !alive) return;
        const url = URL.createObjectURL(await res.blob());
        setQr((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      } catch {
        // Next tick tries again.
      }
    };
    void loadQr();
    const poll = window.setInterval(refresh, 4000);
    const rotate = window.setInterval(() => void loadQr(), 15000);
    return () => {
      alive = false;
      window.clearInterval(poll);
      window.clearInterval(rotate);
    };
  }, [status, refresh]);

  if (!status) return null;

  const run = async (path: string, done?: string) => {
    setNote(null);
    try {
      const next = await api<Status | { sentTo: string }>(path, { method: 'POST' });
      if ('state' in next) setStatus(next);
      if (done) setNote(done);
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'Dat is niet gelukt');
    }
  };

  return (
    <div className="wa-link">
      <h3>Verzendnummer (beheerder)</h3>
      <p className="muted">
        Status: <strong>{STATE_LABEL[status.state] ?? status.state}</strong>
        {status.number && ` · ${status.number}`}
      </p>
      {status.state === 'SCAN_QR_CODE' && (
        <div className="wa-qr">
          {qr ? <img src={qr} alt="QR-code om WhatsApp te koppelen" /> : <p>QR-code laden…</p>}
          <p className="muted">
            Open WhatsApp op de gsm van het verzendnummer → Instellingen → Gekoppelde apparaten →
            Apparaat koppelen, en scan deze code.
          </p>
        </div>
      )}
      <div className="settings-actions">
        {['STOPPED', 'FAILED', 'SCAN_QR_CODE'].includes(status.state) && (
          <button
            type="button"
            className={status.state === 'SCAN_QR_CODE' ? 'btn' : 'btn btn-primary'}
            onClick={() => void run('/whatsapp/admin/start')}
          >
            {status.state === 'SCAN_QR_CODE' ? 'Nieuwe QR-code' : 'Koppelen'}
          </button>
        )}
        {status.state === 'WORKING' && (
          <>
            <button
              type="button"
              className="btn"
              disabled={!canTest}
              title={canTest ? undefined : 'Sla eerst je eigen nummer op'}
              onClick={() => void run('/whatsapp/admin/test', 'Testbericht verstuurd naar je eigen nummer.')}
            >
              Testbericht
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void run('/whatsapp/admin/logout')}>
              Ontkoppelen
            </button>
          </>
        )}
        <button type="button" className="btn" onClick={refresh}>
          Vernieuwen
        </button>
      </div>
      {note && <p className="settings-ok">{note}</p>}
    </div>
  );
}
