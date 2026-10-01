import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { PhotoCandidate } from '../api/types';
import { formatDay } from '../lib/colors';
import { useSheetDismiss } from '../lib/useSheetDismiss';
import { AuthImage } from './AuthImage';
import { Icon } from './Icon';
import './photopicker.css';

export type PickerTab = 'new' | 'hidden';

/** The server takes at most this many ids per list in one request. */
const CHUNK = 1000;

/**
 * Choosing which of your Immich photos the trip shows.
 *
 * A sync used to put every picture of the trip's days straight in, and taking
 * the unwanted ones out afterwards was the only way to tidy up. Now the new
 * photos are offered here first, nothing ticked: what you tick goes in, what
 * you leave goes to "Verborgen", where it can still be put in later. Immich is
 * never touched either way. Only your own library — a companion picks theirs.
 */
export function PhotoPicker({
  tripId,
  initialTab,
  onClose,
  closing,
  onAdded,
}: {
  tripId: string;
  initialTab: PickerTab;
  onClose: () => void;
  closing: boolean;
  /** Photos went into the trip: load them again. */
  onAdded: (count: number) => void;
}) {
  const sheet = useSheetDismiss(onClose);
  const [tab, setTab] = useState<PickerTab>(initialTab);
  const [candidates, setCandidates] = useState<PhotoCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<PhotoCandidate[]>(`/trips/${tripId}/media/candidates`)
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ophalen mislukt');
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const counts = useMemo(() => {
    const all = candidates ?? [];
    return {
      new: all.filter((c) => c.status === 'new').length,
      hidden: all.filter((c) => c.status === 'hidden').length,
    };
  }, [candidates]);

  const shown = useMemo(
    () => (candidates ?? []).filter((c) => c.status === tab),
    [candidates, tab],
  );

  /** Grouped by the day they were taken, in the order they were taken. */
  const days = useMemo(() => {
    const map = new Map<string, PhotoCandidate[]>();
    for (const c of shown) {
      const key = new Date(c.takenAt).toLocaleDateString('sv-SE');
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return [...map.entries()];
  }, [shown]);

  function switchTab(next: PickerTab) {
    if (next === tab) return;
    setTab(next);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setMany(ids: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function confirm() {
    const add = shown.filter((c) => selected.has(c.immichAssetId)).map((c) => c.immichAssetId);
    // Only new photos are put away: a hidden one that is not picked simply
    // stays where it is.
    const hide =
      tab === 'new'
        ? shown.filter((c) => !selected.has(c.immichAssetId)).map((c) => c.immichAssetId)
        : [];
    if (add.length === 0 && hide.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let added = 0;
      for (let i = 0; i < Math.max(add.length, hide.length); i += CHUNK) {
        const result = await api<{ added: number; hidden: number }>(
          `/trips/${tripId}/media/pick`,
          {
            method: 'POST',
            body: { add: add.slice(i, i + CHUNK), hide: hide.slice(i, i + CHUNK) },
          },
        );
        added += result.added;
      }
      onAdded(added);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan mislukt');
      setBusy(false);
    }
  }

  const count = shown.filter((c) => selected.has(c.immichAssetId)).length;
  const rest = shown.length - count;

  let action: string;
  if (tab === 'new') {
    action =
      count === 0
        ? shown.length === 1
          ? 'Niets tonen, 1 verbergen'
          : `Niets tonen, ${shown.length} verbergen`
        : count === 1
          ? '1 foto tonen'
          : `${count} foto's tonen`;
  } else {
    action = count === 1 ? '1 foto tonen' : `${count} foto's tonen`;
  }

  return createPortal(
    <div className={`people-sheet-backdrop ${closing ? 'closing' : ''}`} onClick={onClose}>
      <div
        className="people-sheet card picker-sheet"
        ref={sheet.ref}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Foto's kiezen"
        {...sheet.handlers}
      >
        <div className="people-sheet-head">
          <h2>Foto&apos;s kiezen</h2>
          <button className="icon-btn" aria-label="Sluiten" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>

        <div className="picker-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'new'}
            className={tab === 'new' ? 'active' : ''}
            onClick={() => switchTab('new')}
          >
            Nieuw{candidates && ` (${counts.new})`}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'hidden'}
            className={tab === 'hidden' ? 'active' : ''}
            onClick={() => switchTab('hidden')}
          >
            Verborgen{candidates && ` (${counts.hidden})`}
          </button>
        </div>

        <p className="muted picker-hint">
          {tab === 'new'
            ? "Tik de foto's aan die je in deze reis wilt tonen. De rest gaat naar Verborgen. In Immich blijft alles staan."
            : "Foto's die je eerder niet koos of uit de reis haalde. Tik aan wat je alsnog wilt tonen."}
        </p>

        {error && <p className="error-text">{error}</p>}

        {!candidates && !error && (
          <p className="muted picker-empty">
            <Icon name="reload" size={15} className="spin" /> Foto&apos;s ophalen uit Immich…
          </p>
        )}

        {candidates && shown.length === 0 && (
          <p className="muted picker-empty">
            {tab === 'new'
              ? "Geen nieuwe foto's in Immich voor deze reisdagen."
              : "Er zijn geen verborgen foto's."}
          </p>
        )}

        {days.map(([day, items]) => {
          const ids = items.map((c) => c.immichAssetId);
          const allOn = ids.every((id) => selected.has(id));
          return (
            <section key={day} className="picker-day">
              <div className="picker-day-head">
                <h3 className="trip-side-heading">{formatDay(items[0]!.takenAt)}</h3>
                <button
                  type="button"
                  className="timeline-select-day"
                  onClick={() => setMany(ids, !allOn)}
                >
                  {allOn ? 'Niets van deze dag' : 'Hele dag'}
                </button>
              </div>
              <div className="picker-grid">
                {items.map((c) => {
                  const on = selected.has(c.immichAssetId);
                  return (
                    <button
                      key={c.immichAssetId}
                      type="button"
                      className={`picker-photo ${on ? 'selected' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggle(c.immichAssetId)}
                    >
                      <AuthImage
                        path={`/trips/${tripId}/media/candidates/${c.immichAssetId}/thumbnail`}
                        alt=""
                        className="picker-img"
                      />
                      {c.assetType === 'VIDEO' && (
                        <span className="picker-video">
                          <Icon name="play" size={12} />
                        </span>
                      )}
                      <span className="picker-check">
                        <Icon name="check" size={13} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        {shown.length > 0 && (
          <div className="picker-bar">
            <span className="picker-bar-count">
              {count} van {shown.length}
            </span>
            <button
              type="button"
              className="photo-select-clear"
              onClick={() =>
                setMany(
                  shown.map((c) => c.immichAssetId),
                  rest > 0,
                )
              }
            >
              {rest > 0 ? 'Alles' : 'Niets'}
            </button>
            <button
              type="button"
              className="btn btn-primary picker-confirm"
              disabled={busy || (tab === 'hidden' && count === 0)}
              onClick={() => void confirm()}
            >
              {busy ? 'Bezig…' : action}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
