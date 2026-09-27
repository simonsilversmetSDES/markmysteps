import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { MediaItem, SyncResult } from '../api/types';
import { isLocalMode } from '../lib/localMode';
import { useExit } from '../lib/useExit';

import { confirmModal } from './confirm';
import { Icon } from './Icon';
import './phototools.css';

/**
 * The trip's photos, looked after from the trip itself.
 *
 * Syncing used to live three screens away in the trip's settings, which is not
 * where you are when you come back from a day out and want today's pictures
 * in. And there was no way at all to take a photo out: the screenshot of a
 * ticket, the fifteen near-identical shots of one fountain. Taking one out
 * never touches Immich — the photo stays in the library, the trip just stops
 * showing it, and later syncs leave it out.
 */
export function PhotoTools({
  tripId,
  media,
  selecting,
  selected,
  onSelecting,
  onClearSelection,
  onRemoved,
  onChanged,
}: {
  tripId: string;
  /** Every photo on the trip, to find what a selected id refers to. */
  media: MediaItem[];
  selecting: boolean;
  selected: Set<string>;
  onSelecting: (on: boolean) => void;
  onClearSelection: () => void;
  /** Taken out on the server: drop them from what is on screen right away. */
  onRemoved: (ids: string[]) => void;
  /** The trip's photos changed on the server: load them again. */
  onChanged: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the last removal took out, by Immich id, for "Ongedaan maken". */
  const [undo, setUndo] = useState<{ count: number; assetIds: string[] } | null>(null);
  const undoTimer = useRef<number | null>(null);
  const [undoShown, undoClosing] = useExit(undo !== null, 240);
  const lastUndoCount = useRef(0);
  if (undo) lastUndoCount.current = undo.count;
  const [barShown, barClosing] = useExit(selecting, 220);

  useEffect(
    () => () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  // A message that stays forever turns into part of the furniture.
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(t);
  }, [message]);

  async function sync() {
    setSyncing(true);
    setMessage(null);
    try {
      const result = await api<SyncResult>(`/trips/${tripId}/sync`, { method: 'POST' });
      setMessage(
        result.assetsAdded === 0
          ? `Alles is al binnen (${result.assetsFound} gevonden).`
          : result.assetsAdded === 1
            ? '1 nieuwe foto.'
            : `${result.assetsAdded} nieuwe foto's.`,
      );
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Sync mislukt');
    } finally {
      setSyncing(false);
    }
  }

  async function removeSelected() {
    const items = media.filter((m) => selected.has(m.id));
    if (items.length === 0) return;
    const n = items.length;
    const ok = await confirmModal({
      title: n === 1 ? 'Foto uit deze reis halen?' : `${n} foto's uit deze reis halen?`,
      body:
        'Ze blijven gewoon in Immich staan. Een volgende sync zet ze niet terug; ' +
        'meteen hierna kun je het nog ongedaan maken.',
      confirmLabel: 'Uit reis halen',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await api<{ removed: number; removedIds: string[] }>(
        `/trips/${tripId}/media/remove`,
        { method: 'POST', body: { ids: items.map((m) => m.id) } },
      );
      const gone = new Set(result.removedIds);
      onRemoved(result.removedIds);
      onClearSelection();
      onSelecting(false);
      const skipped = n - result.removed;
      if (skipped > 0) {
        setMessage(
          `${skipped} ${skipped === 1 ? 'foto is' : "foto's zijn"} van een reisgenoot en ${
            skipped === 1 ? 'bleef' : 'bleven'
          } staan.`,
        );
      }
      if (result.removed > 0) {
        setUndo({
          count: result.removed,
          assetIds: items.filter((m) => gone.has(m.id)).map((m) => m.immichAssetId),
        });
        if (undoTimer.current) window.clearTimeout(undoTimer.current);
        undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Verwijderen mislukt');
    } finally {
      setBusy(false);
    }
  }

  async function undoRemove() {
    if (!undo) return;
    const { assetIds } = undo;
    setUndo(null);
    try {
      await api(`/trips/${tripId}/media/restore`, {
        method: 'POST',
        body: { immichAssetIds: assetIds },
      });
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Terugzetten mislukt');
    }
  }

  const count = selected.size;

  return (
    <>
      <div className="photo-tools">
        <button
          type="button"
          className="btn btn-ghost photo-tools-btn"
          onClick={() => void sync()}
          disabled={syncing || selecting}
        >
          <Icon name="reload" size={15} className={syncing ? 'spin' : undefined} />
          {syncing ? 'Bezig met syncen…' : "Foto's syncen"}
        </button>
        {!isLocalMode() && (
          <button
            type="button"
            className={`btn photo-tools-btn ${selecting ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => {
              if (selecting) onClearSelection();
              onSelecting(!selecting);
            }}
            aria-pressed={selecting}
          >
            <Icon name={selecting ? 'check' : 'trash'} size={15} />
            {selecting ? 'Klaar' : 'Selecteren'}
          </button>
        )}
      </div>
      {selecting && (
        <p className="muted photo-tools-hint">
          Tik de foto's aan die uit deze reis moeten, of kies een hele dag. In Immich blijven ze
          staan.
        </p>
      )}
      {message && (
        <p className="photo-tools-msg" role="status">
          {message}
        </p>
      )}

      {barShown &&
        createPortal(
          <div className={`photo-select-bar ${barClosing ? 'leaving' : ''}`}>
            <span className="photo-select-count">
              {count === 0 ? 'Niets geselecteerd' : count === 1 ? '1 foto' : `${count} foto's`}
            </span>
            {count > 0 && (
              <button type="button" className="photo-select-clear" onClick={onClearSelection}>
                Wissen
              </button>
            )}
            <button
              type="button"
              className="btn btn-danger photo-select-remove"
              disabled={count === 0 || busy}
              onClick={() => void removeSelected()}
            >
              <Icon name="trash" size={15} />
              Uit reis halen
            </button>
          </div>,
          document.body,
        )}

      {undoShown &&
        createPortal(
          <div className={`undo-pill ${undoClosing ? 'leaving' : ''}`}>
            <span className="undo-text">
              <strong>
                {lastUndoCount.current === 1 ? '1 foto' : `${lastUndoCount.current} foto's`}
              </strong>{' '}
              uit de reis gehaald
            </span>
            <button type="button" className="undo-btn" onClick={() => void undoRemove()}>
              Ongedaan maken
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
