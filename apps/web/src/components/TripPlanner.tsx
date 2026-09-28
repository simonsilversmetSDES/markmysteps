import {
  CSSProperties,
  DragEvent,
  FormEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { Trip } from '../api/types';
import { CityThumb } from './CityThumb';
import { DateField } from './DatePicker';
import { FlightEditor } from './FlightEditor';
import { Icon, MODE_ICON } from './Icon';
import { WeatherBadge } from './WeatherBadge';
import {
  estimateDuration,
  haversineKm,
  MODE_LABEL,
  PlannedStop,
  TRAVEL_MODES,
  TravelMode,
} from '../lib/arc';
import { airportByCode } from '../lib/airports';
import { formatDate, formatDateRange } from '../lib/colors';
import { PlaceSuggestion, reversePlace, searchPlaces } from '../lib/geocode';
import { StopSuggestions, type StaySuggestion } from './StopSuggestions';
import { haptic } from '../lib/haptics';
import { useExit } from '../lib/useExit';
import { cachePutJson } from '../lib/offlineCache';
import { enqueueWrite, onPendingChange } from '../lib/pendingWrites';
import {
  localCreate,
  localDelete,
  localReorder,
  localUpdate,
} from '../lib/plannerLocal';
import '../pages/plan.css';
import { Flag } from './Flag';

// Names used for the standalone outbound/return legs (any travel mode).
const LEG_NAMES = new Set(['Heenreis', 'Terugreis', 'Heenvlucht', 'Terugvlucht']);

interface TripPlannerProps {
  tripId: string;
  trip: Trip | null;
  stops: PlannedStop[];
  /** Push the edited stop list up so the shared map redraws. */
  onStopsChange: (stops: PlannedStop[]) => void;
  /** Let the parent refresh trip-level data (end date may shift with the plan). */
  onChanged?: () => void;
  /** A location tapped on the shared map, used for the next stop. */
  pickedCoords: { lat: number; lng: number } | null;
  onPickConsumed: () => void;
  /** Ease the shared map to a searched place. */
  onFlyTo: (lng: number, lat: number) => void;
  /**
   * Where the pin on the shared map should stand: the place chosen for the
   * new stop, or for the stop being edited. Null takes it away.
   */
  onPinChange?: (pin: { lat: number; lng: number } | null) => void;
  /** "Aanduiden op kaart": bring the map into view and drop a pin to drag. */
  onPlaceOnMap?: () => void;
  /** Guest view: the same itinerary, with nothing to press. */
  readOnly?: boolean;
  /**
   * Draw the rails of a train leg. A train is the one mode the tracker cannot
   * follow — tunnels, cuttings, a steel carriage — so the planner offers to
   * fill the leg in from the two stations instead.
   */
  onDrawTrain?: (leg: {
    from: string;
    to: string;
    at: { lng: number; lat: number };
  }) => void;
}

/**
 * Inline route planner: the same stop list / flight legs as the standalone page
 * but driven by the trip detail map (no second map instance to reload).
 */
export function TripPlanner({
  tripId,
  trip,
  stops,
  onStopsChange,
  onChanged,
  pickedCoords,
  onPickConsumed,
  onFlyTo,
  onPinChange,
  onPlaceOnMap,
  readOnly = false,
  onDrawTrain,
}: TripPlannerProps) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newNights, setNewNights] = useState(2);
  const [newCountry, setNewCountry] = useState<string | undefined>();
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  /** The last search came back empty: time to offer the map instead. */
  const [noResults, setNoResults] = useState(false);
  /**
   * Where the new stop goes. A place picked from the search brings its own
   * spot; one pointed at on the map keeps its spot whatever you then call it.
   */
  const [pick, setPick] = useState<{ lat: number; lng: number; source: 'search' | 'map' } | null>(
    null,
  );
  /** The stop whose name and place are open for editing, with its draft pin. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPin, setEditPin] = useState<{ lat: number; lng: number } | null>(null);
  const [editCountry, setEditCountry] = useState<string | null>(null);
  /** The stop whose day-trip panel is open, and the place being set for it. */
  const [dayTripFor, setDayTripFor] = useState<string | null>(null);
  const [dayPin, setDayPin] = useState<{ lat: number; lng: number } | null>(null);
  const [dayCountry, setDayCountry] = useState<string | null>(null);
  /** A name for the day trip from where its pin landed; only fills an empty field. */
  const [daySuggestedName, setDaySuggestedName] = useState<string | null>(null);
  /** Only the newest reverse lookup may write: a slow answer for a spot you
   *  already moved away from must not overwrite the one for where you are. */
  const lookupRef = useRef(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<number | null>(null);

  // Day trips hang off a stop; they are not rows of the route, so everything
  // that walks the itinerary (numbering, legs, dragging) uses `route`.
  const route = stops.filter((s) => !s.parentStopId);
  const dayTripsByParent = new Map<string, PlannedStop[]>();
  for (const s of stops) {
    if (!s.parentStopId) continue;
    dayTripsByParent.set(s.parentStopId, [...(dayTripsByParent.get(s.parentStopId) ?? []), s]);
  }

  const plannedNights = route.reduce((sum, s) => sum + s.nights, 0);
  const tripNights = trip
    ? Math.round(
        (new Date(trip.endDate).getTime() - new Date(trip.startDate).getTime()) / 86_400_000,
      )
    : 0;

  // A standalone heen-/terugreis leg is identified by its name ALONE. It may
  // well carry a coordinate (the begin/end point you picked); that must not turn
  // it back into a normal stop row — it stays the slim leg bar.
  const isStandaloneLeg = (s?: PlannedStop) => !!s && LEG_NAMES.has(s.name);
  const hasOutbound = isStandaloneLeg(route[0]);
  const hasReturn = isStandaloneLeg(route[route.length - 1]);

  // First/last real city (with coordinates) — used to auto-fill airports on the
  // outbound/return flight legs.
  const cityCoord = (s?: PlannedStop | null): [number, number] | null =>
    s && !isStandaloneLeg(s) && s.latitude !== null && s.longitude !== null
      ? [s.longitude, s.latitude]
      : null;
  const firstCity = cityCoord(route.find((s) => cityCoord(s)));
  const lastCity = cityCoord([...route].reverse().find((s) => cityCoord(s)));

  const refresh = (updated: PlannedStop[]) => {
    onStopsChange(updated);
    onChanged?.();
  };

  /**
   * Every planner edit goes through here.
   *
   * With a connection it is a plain API call and the server answers with the
   * recomputed list. Without one the same rules are applied locally, the list
   * is written to the read cache so it survives a restart, and the request is
   * queued to be replayed once there is a network again.
   */
  const tripStart = trip?.startDate ?? route[0]?.arrivalDate ?? new Date().toISOString();

  async function mutate(
    path: string,
    method: string,
    body: unknown,
    local: (current: PlannedStop[]) => PlannedStop[],
  ): Promise<PlannedStop[]> {
    try {
      return await api<PlannedStop[]>(path, { method, body });
    } catch (err) {
      // A status means the server answered and refused; only a missing network
      // is worth queueing.
      if (typeof (err as { status?: number }).status === 'number') throw err;
      enqueueWrite({ path, method, body });
      const next = local(stops);
      void cachePutJson(`/trips/${tripId}/stops`, next);
      return next;
    }
  }

  const stopsPath = `/trips/${tripId}/stops`;

  function onNameInput(value: string) {
    setNewName(value);
    setNoResults(false);
    // A place found by name goes with that name. Type something else and the
    // spot goes too — otherwise "Brugge" would quietly land in Gent. A spot
    // pointed at on the map stays: that is exactly the case of a place the
    // search does not know by the name you are giving it.
    if (pick?.source !== 'map') {
      setNewCountry(undefined);
      if (pick) setPick(null);
    }
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      searchPlaces(value, controller.signal, { anyPlace: true })
        .then((found) => {
          setSuggestions(found);
          setNoResults(found.length === 0 && value.trim().length >= 3);
        })
        .catch(() => undefined);
    }, 280);
  }

  function pickSuggestion(place: PlaceSuggestion) {
    setNewName(place.name);
    setNewCountry(place.countryCode);
    setSuggestions([]);
    setNoResults(false);
    onFlyTo(place.longitude, place.latitude);
    setPick({ lat: place.latitude, lng: place.longitude, source: 'search' });
  }

  /**
   * Which country a spot on the map lies in, for the flag and the trip's
   * country count, and a name for the new stop if it has none yet. Never
   * overwrites a name you typed.
   */
  function lookUp(at: { lat: number; lng: number }, target: 'new' | 'edit' | 'day') {
    const token = ++lookupRef.current;
    void reversePlace(at.lat, at.lng).then((found) => {
      if (token !== lookupRef.current || !found) return;
      if (target === 'edit') {
        setEditCountry(found.countryCode ?? null);
        return;
      }
      if (target === 'day') {
        setDayCountry(found.countryCode ?? null);
        setDaySuggestedName(found.name);
        return;
      }
      setNewCountry(found.countryCode);
      if (found.name) setNewName((current) => (current.trim() ? current : found.name!));
    });
  }

  // A tap on the shared map, or the pin dragged there, lands here as one
  // event: it goes to the stop being edited if there is one, else to the day
  // trip being added, else to the new stop.
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const dayTripForRef = useRef(dayTripFor);
  dayTripForRef.current = dayTripFor;
  useEffect(() => {
    if (!pickedCoords || readOnly) return;
    const at = { lat: pickedCoords.lat, lng: pickedCoords.lng };
    onPickConsumed();
    if (editingIdRef.current) {
      setEditPin(at);
      lookUp(at, 'edit');
    } else if (dayTripForRef.current) {
      setDayPin(at);
      lookUp(at, 'day');
    } else {
      setPick({ ...at, source: 'map' });
      setSuggestions([]);
      lookUp(at, 'new');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedCoords]);

  // A day-trip panel opens empty, and closing it forgets where it was pointing.
  useEffect(() => {
    lookupRef.current++;
    setDayPin(null);
    setDayCountry(null);
    setDaySuggestedName(null);
  }, [dayTripFor]);

  // The pin follows whatever is being placed.
  const pin = editingId ? editPin : dayTripFor ? dayPin : pick;
  useEffect(() => {
    onPinChange?.(pin ? { lat: pin.lat, lng: pin.lng } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.lat, pin?.lng]);
  useEffect(
    () => () => onPinChange?.(null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function addStop(event: FormEvent) {
    event.preventDefault();
    try {
      const body = {
        id: crypto.randomUUID(),
        name: newName.trim(),
        nights: newNights,
        latitude: pick?.lat,
        longitude: pick?.lng,
        countryCode: newCountry,
      };
      const updated = await mutate(stopsPath, 'POST', body, (current) =>
        localCreate(current, tripStart, body),
      );
      refresh(updated);
      setNewName('');
      setNewNights(2);
      setNewCountry(undefined);
      setSuggestions([]);
      setNoResults(false);
      setPick(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stop toevoegen mislukt');
    }
  }

  function startEditing(stop: PlannedStop) {
    setDayTripFor(null);
    setEditingId(stop.id);
    const at =
      stop.latitude !== null && stop.longitude !== null
        ? { lat: stop.latitude, lng: stop.longitude }
        : null;
    setEditPin(at);
    setEditCountry(stop.countryCode);
    if (at) onFlyTo(at.lng, at.lat);
  }

  function stopEditing() {
    lookupRef.current++;
    setEditingId(null);
    setEditPin(null);
    setEditCountry(null);
  }

  /** A search result picked while editing moves the pin there. */
  function pickEditPlace(place: PlaceSuggestion) {
    lookupRef.current++;
    setEditPin({ lat: place.latitude, lng: place.longitude });
    setEditCountry(place.countryCode ?? null);
    onFlyTo(place.longitude, place.latitude);
  }

  async function saveStopEdit(stop: PlannedStop, name: string) {
    const data = {
      name: name.trim(),
      ...(editPin ? { latitude: editPin.lat, longitude: editPin.lng } : {}),
      ...(editCountry ? { countryCode: editCountry } : {}),
    };
    try {
      refresh(
        await mutate(`${stopsPath}/${stop.id}`, 'PATCH', data, (current) =>
          localUpdate(current, tripStart, stop.id, data),
        ),
      );
      stopEditing();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stop opslaan mislukt');
    }
  }

  /**
   * A stay the track found, accepted as a stop.
   *
   * It lands at the end of the route like any new stop; the nights come from
   * how long you actually stayed, which is what makes this worth a press
   * rather than a form.
   */
  async function addSuggestedStop(stay: StaySuggestion, name: string, countryCode?: string) {
    const body = {
      id: crypto.randomUUID(),
      name,
      nights: stay.nights,
      latitude: stay.latitude,
      longitude: stay.longitude,
      countryCode,
    };
    refresh(
      await mutate(stopsPath, 'POST', body, (current) => localCreate(current, tripStart, body)),
    );
    onChanged?.();
  }

  async function saveFlight(
    stop: PlannedStop,
    data: { flightNumber?: string; fromAirport?: string; toAirport?: string; viaAirports?: string[] },
  ) {
    refresh(
      await mutate(`${stopsPath}/${stop.id}`, 'PATCH', data, (current) =>
        localUpdate(current, tripStart, stop.id, data),
      ),
    );
  }

  // Give a standalone heen-/terugreis leg an origin/destination coordinate, so
  // its driven kilometres get counted toward the trip distance.
  async function saveLegLocation(
    stop: PlannedStop,
    data: { latitude: number; longitude: number; countryCode?: string; notes?: string },
  ) {
    refresh(
      await mutate(`${stopsPath}/${stop.id}`, 'PATCH', data, (current) =>
        localUpdate(current, tripStart, stop.id, data),
      ),
    );
  }

  /** A stop's own notes, shown under it on the share page. Empty clears them. */
  async function saveNotes(stop: PlannedStop, text: string) {
    const notes = text.trim();
    if (notes === (stop.notes ?? '')) return;
    refresh(
      await mutate(`${stopsPath}/${stop.id}`, 'PATCH', { notes }, (current) =>
        localUpdate(current, tripStart, stop.id, { notes }),
      ),
    );
  }

  async function changeNights(stop: PlannedStop, delta: number) {
    const nights = Math.max(0, stop.nights + delta);
    refresh(
      await mutate(`${stopsPath}/${stop.id}`, 'PATCH', { nights }, (current) =>
        localUpdate(current, tripStart, stop.id, { nights }),
      ),
    );
  }

  // How many edits are still waiting for a connection, so it's clear the plan
  // is saved on the device rather than lost.
  const [pending, setPending] = useState(0);
  useEffect(() => onPendingChange((list) => setPending(list.length)), []);
  // Both of these disappear on their own, so they need to be held on screen
  // long enough to animate out — and to keep their text while they do.
  const [pendingShown, pendingClosing] = useExit(pending > 0, 240);
  const lastPendingRef = useRef(pending);
  if (pending > 0) lastPendingRef.current = pending;
  const lastPending = lastPendingRef.current;

  // Which stop currently has its "add a day trip" panel expanded.

  /** An excursion from `parent` and back the same day (Saltsjöbaden → Stockholm). */
  /** A search result picked in the day-trip panel moves its pin there. */
  function pickDayPlace(place: PlaceSuggestion | null) {
    lookupRef.current++;
    setDayPin(place ? { lat: place.latitude, lng: place.longitude } : null);
    setDayCountry(place?.countryCode ?? null);
    if (place) onFlyTo(place.longitude, place.latitude);
  }

  async function addDayTrip(parent: PlannedStop, name: string, day: string) {
    try {
      const body = {
        id: crypto.randomUUID(),
        name: name.trim(),
        nights: 0,
        latitude: dayPin?.lat,
        longitude: dayPin?.lng,
        countryCode: dayCountry ?? undefined,
        parentStopId: parent.id,
        dayTripDate: day,
      };
      refresh(
        await mutate(stopsPath, 'POST', body, (current) => localCreate(current, tripStart, body)),
      );
      if (dayPin) onFlyTo(dayPin.lng, dayPin.lat);
      setDayTripFor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dagtrip toevoegen mislukt');
    }
  }

  async function setDayTripDate(dayTrip: PlannedStop, day: string) {
    refresh(
      await mutate(`${stopsPath}/${dayTrip.id}`, 'PATCH', { dayTripDate: day }, (current) =>
        localUpdate(current, tripStart, dayTrip.id, { dayTripDate: day }),
      ),
    );
  }

  // Deleting plays a collapse animation first, then hits the API — otherwise the
  // row (a leg bar especially) just blinks out of existence.
  const [removingId, setRemovingId] = useState<string | null>(null);

  /** What the last delete removed, so it can be put back. Deleting a stop takes
   *  its day trips with it, so those are remembered too. */
  const [undo, setUndo] = useState<{
    stop: PlannedStop;
    dayTrips: PlannedStop[];
    afterId: string | null;
  } | null>(null);
  const undoTimer = useRef<number | null>(null);
  const [undoShown, undoClosing] = useExit(undo !== null, 240);
  const lastUndoNameRef = useRef('');
  if (undo) lastUndoNameRef.current = undo.stop.name;
  const lastUndoName = lastUndoNameRef.current;

  const offerUndo = (entry: NonNullable<typeof undo>) => {
    setUndo(entry);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 7000);
  };

  useEffect(() => {
    return () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
    };
  }, []);

  async function removeStop(stop: PlannedStop) {
    // Captured before the delete, because that is when the route still knows
    // where this stop sat and which day trips hung off it.
    const previous = stop.parentStopId
      ? null
      : route[route.findIndex((s) => s.id === stop.id) - 1]?.id ?? null;
    const children = stop.parentStopId ? [] : dayTripsByParent.get(stop.id) ?? [];

    setRemovingId(stop.id);
    await new Promise((r) => window.setTimeout(r, 240));
    try {
      refresh(
        await mutate(`${stopsPath}/${stop.id}`, 'DELETE', undefined, (current) =>
          localDelete(current, tripStart, stop.id),
        ),
      );
      offerUndo({ stop, dayTrips: children, afterId: previous });
    } finally {
      setRemovingId(null);
    }
  }

  /** Re-creates the deleted stop where it was, with its day trips. */
  async function undoDelete() {
    if (!undo) return;
    const { stop, dayTrips, afterId } = undo;
    setUndo(null);
    try {
      // Re-created with its ORIGINAL id: nothing else refers to it any more,
      // and keeping it means the day trips can be hung back on it without
      // having to work out which row is the new one.
      const body = {
        id: stop.id,
        name: stop.name,
        nights: stop.nights,
        latitude: stop.latitude ?? undefined,
        longitude: stop.longitude ?? undefined,
        countryCode: stop.countryCode ?? undefined,
        travelMode: stop.travelMode,
        flightNumber: stop.flightNumber ?? undefined,
        fromAirport: stop.fromAirport ?? undefined,
        toAirport: stop.toAirport ?? undefined,
        viaAirports: stop.viaAirports?.length ? stop.viaAirports : undefined,
        notes: stop.notes ?? undefined,
        parentStopId: stop.parentStopId ?? undefined,
        dayTripDate: stop.parentStopId ? stop.arrivalDate.slice(0, 10) : undefined,
        afterStopId: afterId ?? undefined,
      };
      let list = await mutate(stopsPath, 'POST', body, (current) =>
        localCreate(current, tripStart, body),
      );

      for (const child of dayTrips) {
        const childBody = {
          id: child.id,
          name: child.name,
          nights: 0,
          latitude: child.latitude ?? undefined,
          longitude: child.longitude ?? undefined,
          countryCode: child.countryCode ?? undefined,
          parentStopId: stop.id,
          dayTripDate: child.arrivalDate.slice(0, 10),
        };
        list = await mutate(stopsPath, 'POST', childBody, (current) =>
          localCreate(current, tripStart, childBody),
        );
      }

      // afterStopId has no way to say "at the very front", so a stop that was
      // first is put back there with an explicit reorder.
      if (!stop.parentStopId && afterId === null) {
        const order = [
          stop.id,
          ...list.filter((s) => !s.parentStopId && s.id !== stop.id).map((s) => s.id),
        ];
        list = await mutate(`${stopsPath}/order`, 'PUT', { stopIds: order }, (current) =>
          localReorder(current, tripStart, order),
        );
      }
      refresh(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Terugzetten mislukt');
    }
  }

  async function addReturnLeg(mode: TravelMode) {
    const body = { id: crypto.randomUUID(), name: 'Terugreis', nights: 0, travelMode: mode };
    refresh(
      await mutate(stopsPath, 'POST', body, (current) => localCreate(current, tripStart, body)),
    );
  }

  async function addOutboundLeg(mode: TravelMode) {
    const body = { id: crypto.randomUUID(), name: 'Heenreis', nights: 0, travelMode: mode };
    const created = await mutate(stopsPath, 'POST', body, (current) =>
      localCreate(current, tripStart, body),
    );
    // It has to lead the route, and afterStopId cannot express "at the front".
    const order = [body.id, ...created.filter((s) => !s.parentStopId && s.id !== body.id).map((s) => s.id)];
    refresh(
      await mutate(`${stopsPath}/order`, 'PUT', { stopIds: order }, (current) =>
        localReorder(current, tripStart, order),
      ),
    );
  }

  async function setStopMode(stop: PlannedStop, mode: TravelMode) {
    refresh(
      await mutate(`${stopsPath}/${stop.id}`, 'PATCH', { travelMode: mode }, (current) =>
        localUpdate(current, tripStart, stop.id, { travelMode: mode }),
      ),
    );
  }

  /* ---- Touch reordering -------------------------------------------------
     HTML5 drag and drop does not exist on a phone, so a long press picks the
     row up and the rows around it slide out of the way live, showing exactly
     where it will land. */
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [touchDrag, setTouchDrag] = useState<{
    id: string;
    from: number;
    to: number;
    dy: number;
    height: number;
  } | null>(null);
  /** Row boxes as they were when the drag began; the maths stays stable even
   *  while everything is being translated around. */
  const dragRects = useRef<{ top: number; height: number }[]>([]);
  const dragScrollY = useRef(0);
  /** Vertical spacing between rows (the .stop-row margin). */
  const ROW_GAP = 8;

  function beginTouchDrag(stop: PlannedStop, index: number) {
    const rects = route.map((s) => {
      const el = rowRefs.current.get(s.id);
      const box = el?.getBoundingClientRect();
      return { top: box?.top ?? 0, height: box?.height ?? 0 };
    });
    dragRects.current = rects;
    dragScrollY.current = window.scrollY;
    setTouchDrag({
      id: stop.id,
      from: index,
      to: index,
      dy: 0,
      height: rects[index]?.height ?? 0,
    });
  }

  function moveTouchDrag(dy: number) {
    setTouchDrag((current) => {
      if (!current) return current;
      const rects = dragRects.current;
      const own = rects[current.from];
      if (!own) return current;
      // The row follows the finger on screen; the page may have scrolled under
      // it in the meantime, and the row moves with the page.
      const shift = dy + (window.scrollY - dragScrollY.current);
      const centre = own.top + own.height / 2 + shift;
      let to = current.from;
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]!;
        if (centre >= r.top && centre <= r.top + r.height) {
          to = i;
          break;
        }
        if (i === 0 && centre < r.top) to = 0;
        if (i === rects.length - 1 && centre > r.top + r.height) to = i;
      }
      return { ...current, dy: shift, to };
    });
  }

  async function endTouchDrag() {
    const current = touchDrag;
    setTouchDrag(null);
    if (!current || current.to === current.from) return;
    const next = [...route];
    const [moved] = next.splice(current.from, 1);
    next.splice(current.to, 0, moved!);
    onStopsChange([...next, ...stops.filter((s) => s.parentStopId)]); // optimistic
    const order = next.map((s) => s.id);
    refresh(
      await mutate(`${stopsPath}/order`, 'PUT', { stopIds: order }, (current) =>
        localReorder(current, tripStart, order),
      ),
    );
  }

  /** Transform for one row while a reorder is in progress. */
  function rowStyle(index: number, id: string): CSSProperties | undefined {
    if (!touchDrag) return undefined;
    const offset = touchDrag.id === id ? touchDrag.dy : dragOffset(index);
    return offset === 0 ? undefined : { transform: `translateY(${offset}px)` };
  }

  /** How far row `index` has to step aside to open the gap. */
  function dragOffset(index: number): number {
    if (!touchDrag) return 0;
    const { from, to, height } = touchDrag;
    const step = height + ROW_GAP;
    if (index === from) return 0;
    if (from < to && index > from && index <= to) return -step;
    if (to < from && index >= to && index < from) return step;
    return 0;
  }

  function onDragOver(event: DragEvent, index: number) {
    event.preventDefault();
    if (index !== overIndex) setOverIndex(index);
  }

  async function onDrop() {
    const from = dragIndex;
    const to = overIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || to === null || from === to) return;
    const next = [...route];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onStopsChange(next); // optimistic
    const order = next.map((s) => s.id);
    refresh(
      await mutate(`${stopsPath}/order`, 'PUT', { stopIds: order }, (current) =>
        localReorder(current, tripStart, order),
      ),
    );
  }

  return (
    <div className={`trip-planner ${readOnly ? 'trip-planner-read' : ''}`}>
      {trip && (
        <div className="nights-planned">
          <span className="nights-ring" data-full={plannedNights >= tripNights}>
            ●
          </span>
          {plannedNights}/{tripNights} nachten gepland
        </div>
      )}
      {pendingShown && (
        <div className={`plan-pending ${pendingClosing ? 'leaving' : ''}`}>
          <Icon name="cloud-off" size={14} />
          {lastPending} {lastPending === 1 ? 'wijziging wacht' : 'wijzigingen wachten'} op
          verbinding
        </div>
      )}
      {error && <p className="error-text">{error}</p>}

      {route.length === 0 && (
        <div className="plan-empty">
          <span className="plan-empty-icon">
            <Icon name="compass" size={30} />
          </span>
          <p className="muted">
            {readOnly
              ? 'Er is nog geen route gepland voor deze reis.'
              : `Nog geen stops. Zoek hieronder een stad en bouw je route op. Versleep om te
                 herordenen. Tik het vervoer-pilletje bij een stop om te wisselen tussen auto,
                 trein, bus, boot of vlucht.`}
          </p>
        </div>
      )}

      {!hasOutbound && !readOnly && (
        <ModeMenu label="Heenreis" onPick={(m) => void addOutboundLeg(m)} />
      )}

      <ol className="stop-list">
        {route.map((stop, index) => {
          if (isStandaloneLeg(stop)) {
            const outbound = index === 0;
            const legPt =
              stop.latitude !== null && stop.longitude !== null
                ? ([stop.longitude, stop.latitude] as [number, number])
                : null;
            const otherPt = outbound ? firstCity : lastCity;
            // How far this leg goes. On the ground that is origin to the
            // nearest city; in the air it is airport to airport, which the
            // flight pill knows but never said — the row simply had a hole
            // where its distance belonged.
            const legFrom = airportByCode(stop.fromAirport);
            const legTo = airportByCode(stop.toAirport);
            const legLegKm =
              stop.travelMode === 'FLIGHT'
                ? legFrom && legTo
                  ? haversineKm([legFrom.lon, legFrom.lat], [legTo.lon, legTo.lat])
                  : null
                : legPt && otherPt
                  ? haversineKm(legPt, otherPt)
                  : null;
            return (
              <li
                key={stop.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(stop.id, el);
                  else rowRefs.current.delete(stop.id);
                }}
                className={`stop-row ${removingId === stop.id ? 'leaving' : ''} ${
                  touchDrag?.id === stop.id ? 'lifted' : ''
                }`}
                style={rowStyle(index, stop.id)}
              >
                <div className="stop-row-inner">
                <SwipeToDelete
                  disabled={readOnly}
                  onDelete={() => removeStop(stop)}
                  label="Reis verwijderen"
                  dragging={touchDrag?.id === stop.id}
                  onDragStart={() => beginTouchDrag(stop, index)}
                  onDragMove={moveTouchDrag}
                  onDragEnd={() => void endTouchDrag()}
                >
                {/* Keyed on the travel mode so switching flight ↔ car/bus
                    remounts the bar and replays its entry animation. */}
                <div className="flight-leg card" key={stop.travelMode}>
                  <div className="flight-leg-head">
                    {/* Just "Heen"/"Terug": the stored name (Heenreis /
                        Heenvlucht) is too long to keep the pills, the distance
                        and the mode menu on one row. */}
                    <strong className="flight-leg-name">
                      {stop.name.startsWith('Heen') ? 'Heen' : 'Terug'}
                    </strong>
                    {stop.travelMode === 'FLIGHT' ? (
                      <FlightEditor
                        flightNumber={stop.flightNumber}
                        fromAirport={stop.fromAirport}
                        toAirport={stop.toAirport}
                        viaAirports={stop.viaAirports}
                        toCity={outbound ? firstCity : null}
                        fromCity={outbound ? null : lastCity}
                        onSave={(data) => void saveFlight(stop, data)}
                        readOnly={readOnly}
                      />
                    ) : (
                      <LegLocation
                        outbound={outbound}
                        hasLocation={legPt !== null}
                        savedLabel={stop.notes}
                        onSave={(data) => void saveLegLocation(stop, data)}
                        onFlyTo={onFlyTo}
                        readOnly={readOnly}
                      />
                    )}
                    {legLegKm !== null && (
                      <AltMetric km={legLegKm} mode={stop.travelMode} />
                    )}
                    <ModeMenu
                      current={stop.travelMode}
                      compact
                      align="right"
                      onPick={(m) => void setStopMode(stop, m)}
                      readOnly={readOnly}
                    />
                  </div>
                </div>
                </SwipeToDelete>
                </div>
              </li>
            );
          }
          const prev = index > 0 ? route[index - 1] : null;
          const prevIsStandalone = isStandaloneLeg(prev ?? undefined);
          const isFlight = stop.travelMode === 'FLIGHT';
          const legKm =
            prev &&
            prev.latitude !== null &&
            prev.longitude !== null &&
            stop.latitude !== null &&
            stop.longitude !== null
              ? haversineKm([prev.longitude, prev.latitude], [stop.longitude, stop.latitude])
              : null;
          return (
            <li
              key={stop.id}
              ref={(el) => {
                if (el) rowRefs.current.set(stop.id, el);
                else rowRefs.current.delete(stop.id);
              }}
              className={`stop-row ${removingId === stop.id ? 'leaving' : ''} ${
                touchDrag?.id === stop.id ? 'lifted' : ''
              }`}
              style={rowStyle(index, stop.id)}
            >
              <div className="stop-row-inner">
              {/* Incoming leg: a mode dropdown (same as heenreis), plus the
                  flight editor when it's a flight. Only from the 2nd stop on —
                  the first stop's arrival is the heenreis. */}
              {index > 0 && !prevIsStandalone && (
                <div className="leg-connector">
                  {/* Every mode looks the same here: the mode pill, and for a
                      flight the airports pill right beside it — no card, no
                      separate treatment. Keyed on the mode so the row replays
                      its swap animation when the flight pill appears or goes. */}
                  <div className="leg-connector-row" key={stop.travelMode}>
                    <ModeMenu
                      current={stop.travelMode}
                      compact
                      onPick={(m) => void setStopMode(stop, m)}
                      readOnly={readOnly}
                    />
                    {isFlight && (
                      <FlightEditor
                        flightNumber={stop.flightNumber}
                        fromAirport={stop.fromAirport}
                        toAirport={stop.toAirport}
                        viaAirports={stop.viaAirports}
                        fromCity={prev ? cityCoord(prev) : null}
                        toCity={cityCoord(stop)}
                        onSave={(data) => void saveFlight(stop, data)}
                        readOnly={readOnly}
                      />
                    )}
                    {legKm !== null && <AltMetric km={legKm} mode={stop.travelMode} />}
                    {/* A train leg the tracker slept through: offer to draw the
                        rails. The point handed over is the middle of the leg,
                        which is the stretch of straight line the drawing looks
                        for. */}
                    {stop.travelMode === 'TRAIN' &&
                      !readOnly &&
                      onDrawTrain &&
                      prev &&
                      prev.latitude !== null &&
                      prev.longitude !== null &&
                      stop.latitude !== null &&
                      stop.longitude !== null && (
                        <button
                          type="button"
                          className="leg-rail-btn"
                          onClick={() =>
                            onDrawTrain({
                              from: prev.name,
                              to: stop.name,
                              at: {
                                lng: (prev.longitude! + stop.longitude!) / 2,
                                lat: (prev.latitude! + stop.latitude!) / 2,
                              },
                            })
                          }
                        >
                          <Icon name="route" size={13} />
                          Spoor tekenen
                        </button>
                      )}
                  </div>
                </div>
              )}
              <SwipeToDelete
                disabled={readOnly}
                onDelete={() => removeStop(stop)}
                label="Stop verwijderen"
                dragging={touchDrag?.id === stop.id}
                onDragStart={() => beginTouchDrag(stop, index)}
                onDragMove={moveTouchDrag}
                onDragEnd={() => void endTouchDrag()}
              >
              <div
                className={`card stop-item ${dragIndex === index ? 'dragging' : ''} ${
                  overIndex === index && dragIndex !== null && dragIndex !== index
                    ? dragIndex < index
                      ? 'drop-after'
                      : 'drop-before'
                    : ''
                }`}
                draggable={!readOnly}
                onDragStart={(e) => {
                  // The whole card is the drag handle, but the day-trip panel
                  // inside it holds a text field — dragging there must type, not
                  // reorder the route.
                  if ((e.target as HTMLElement).closest('.daytrip-panel, .daytrips, .stop-notes')) {
                    e.preventDefault();
                    return;
                  }
                  setDragIndex(index);
                }}
                onDragOver={readOnly ? undefined : (e) => onDragOver(e, index)}
                onDragEnd={readOnly ? undefined : onDrop}
                onDrop={readOnly ? undefined : onDrop}
              >
                <div className="stop-main">
                  <CityThumb name={stop.name} index={index} countryCode={stop.countryCode} />
                  <div className="stop-info">
                    <span className="stop-name-row">
                      <strong>{stop.name}</strong>
                      {!readOnly && (
                        <button
                          type="button"
                          className={`stop-edit-btn ${editingId === stop.id ? 'open' : ''}`}
                          aria-label={`${stop.name} bewerken`}
                          aria-expanded={editingId === stop.id}
                          onClick={() =>
                            editingId === stop.id ? stopEditing() : startEditing(stop)
                          }
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                      )}
                    </span>
                    {/* One line: shortening the range is what keeps the weather
                        beside the dates, so the separator dot is never left
                        dangling at the start of a wrapped line. */}
                    <span className="muted stop-meta">
                      {stop.nights > 0
                        ? formatDateRange(stop.arrivalDate, stop.departureDate)
                        : formatDate(stop.arrivalDate)}
                      {stop.latitude !== null && stop.longitude !== null && (
                        <WeatherBadge
                          lat={stop.latitude}
                          lon={stop.longitude}
                          day={stop.arrivalDate}
                          separator
                        />
                      )}
                    </span>
                  </div>
                  <div className="stop-nights">
                    {/* Read-only, the stepper is the wrong shape: a wide tray
                        built to hold two buttons, with one number rattling
                        around in it. A guest gets a plain pill instead. */}
                    {readOnly ? (
                      <span className="nights-static">
                        {stop.nights}
                        <small>{stop.nights === 1 ? 'nacht' : 'nachten'}</small>
                      </span>
                    ) : (
                      <div className="nights-buttons">
                        <button
                          className="nights-btn"
                          onClick={() => changeNights(stop, -1)}
                          aria-label="Minder nachten"
                        >
                          <Icon name="minus" size={16} />
                        </button>
                        <span className="nights-count">
                          {stop.nights}
                          <small>{stop.nights === 1 ? 'nacht' : 'nachten'}</small>
                        </span>
                        <button
                          className="nights-btn"
                          onClick={() => changeNights(stop, 1)}
                          aria-label="Meer nachten"
                        >
                          <Icon name="plus" size={16} />
                        </button>
                      </div>
                    )}
                    {!readOnly && (
                      <button
                        type="button"
                        className={`daytrip-btn ${dayTripFor === stop.id ? 'open' : ''}`}
                        onClick={() => {
                          if (editingId) stopEditing();
                          setDayTripFor(dayTripFor === stop.id ? null : stop.id);
                        }}
                      >
                        <Icon name="plus" size={13} />
                        Dagtrip
                      </button>
                    )}
                  </div>
                </div>
                {!readOnly && (
                  <StopEdit
                    stop={stop}
                    open={editingId === stop.id}
                    pin={editingId === stop.id ? editPin : null}
                    countryCode={editingId === stop.id ? editCountry : null}
                    onPlaceOnMap={onPlaceOnMap}
                    onPickPlace={pickEditPlace}
                    onCancel={stopEditing}
                    onSave={(name) => void saveStopEdit(stop, name)}
                  />
                )}
                {!readOnly && (
                  <StopNotes notes={stop.notes} onSave={(text) => void saveNotes(stop, text)} />
                )}
                <DayTrips
                  parent={stop}
                  dayTrips={dayTripsByParent.get(stop.id) ?? []}
                  open={dayTripFor === stop.id}
                  removingId={removingId}
                  onClose={() => setDayTripFor(null)}
                  onAdd={(name, date) => addDayTrip(stop, name, date)}
                  onDate={(trip, date) => setDayTripDate(trip, date)}
                  onRemove={removeStop}
                  readOnly={readOnly}
                  pin={dayTripFor === stop.id ? dayPin : null}
                  countryCode={dayTripFor === stop.id ? dayCountry : null}
                  suggestedName={dayTripFor === stop.id ? daySuggestedName : null}
                  onPickPlace={pickDayPlace}
                  onPlaceOnMap={onPlaceOnMap}
                  editingId={editingId}
                  onEdit={(trip) =>
                    editingId === trip.id ? stopEditing() : startEditing(trip)
                  }
                  renderEdit={(trip) => (
                    <StopEdit
                      stop={trip}
                      open={editingId === trip.id}
                      pin={editingId === trip.id ? editPin : null}
                      countryCode={editingId === trip.id ? editCountry : null}
                      onPlaceOnMap={onPlaceOnMap}
                      onPickPlace={pickEditPlace}
                      onCancel={stopEditing}
                      onSave={(name) => void saveStopEdit(trip, name)}
                    />
                  )}
                />
              </div>
              </SwipeToDelete>
              </div>
            </li>
          );
        })}
      </ol>

      {!hasReturn && !readOnly && (
        <ModeMenu label="Terugreis" onPick={(m) => void addReturnLeg(m)} />
      )}

      {/* What the track already knows, before the form where you would have
          typed it in yourself. */}
      {!readOnly && <StopSuggestions tripId={tripId} onAdd={addSuggestedStop} />}

      {!readOnly && (
      <form className="card stop-add" onSubmit={addStop}>
        <div className="field stop-search">
          <label htmlFor="st-name">Nieuwe stop</label>
          <input
            id="st-name"
            required
            autoComplete="off"
            placeholder="Zoek een plaats, of typ zelf een naam"
            value={newName}
            onChange={(e) => onNameInput(e.target.value)}
          />
          {suggestions.length > 0 && (
            <ul className="stop-suggestions card">
              {suggestions.map((place, i) => (
                <li key={i}>
                  <button type="button" onClick={() => pickSuggestion(place)}>
                    <Flag code={place.countryCode} size={17} />
                    <span>
                      <strong>{place.name}</strong>
                      {place.region && <small> {place.region}</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {noResults && !pick && (
            <p className="stop-notfound">
              Niet gevonden? Houd de naam zoals je hem typte en{' '}
              <button type="button" className="link-btn" onClick={onPlaceOnMap}>
                duid de plek aan op de kaart
              </button>
              .
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="st-nights">Nachten</label>
          <input
            id="st-nights"
            type="number"
            min={0}
            max={365}
            value={newNights}
            onChange={(e) => setNewNights(Number(e.target.value))}
          />
        </div>
        <PlaceLine
          pin={pick}
          countryCode={newCountry ?? null}
          fromSearch={pick?.source === 'search'}
          onPlaceOnMap={onPlaceOnMap}
          onClear={() => {
            lookupRef.current++;
            setPick(null);
            setNewCountry(undefined);
          }}
        />
        <button className="btn btn-primary">Stop toevoegen</button>
      </form>
      )}

      {/* Deleting is one gesture, so there has to be a way back. Sits above the
          tab bar and fades out after a few seconds. */}
      {undoShown &&
        createPortal(
          <div className={`undo-pill ${undoClosing ? 'leaving' : ''}`}>
            <span className="undo-text">
              <strong>{lastUndoName}</strong> verwijderd
            </span>
            <button type="button" className="undo-btn" onClick={() => void undoDelete()}>
              Ongedaan maken
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * Swipe a row aside to delete it, either direction.
 *
 * The feel is ported from a Compose implementation that got it right, and it is
 * worth spelling out because "just follow the finger" is what it is NOT:
 *
 *   tension  the row barely moves (20 px at most) for the first 60 px of
 *            travel, so scrolling a list never nudges rows sideways;
 *   release  past that it springs to catch up with the finger, with a haptic
 *            tick — the moment the row comes loose is something you feel;
 *   free     from there it tracks one to one, ticking again when it crosses
 *            (or leaves) the commit threshold;
 *   commit   letting go past the threshold flings the row off in the direction
 *            of travel while its height collapses in step, so the gap closes
 *            instead of the row blinking out.
 *
 * The reveal grows out of the edge you are uncovering rather than sitting
 * behind the row as a full-width block.
 *
 * Touch only: a desktop has no swipe, and the card's drag gesture there is
 * already reordering the route.
 */
function SwipeToDelete({
  onDelete,
  label,
  onDragStart,
  onDragMove,
  onDragEnd,
  dragging,
  disabled,
  children,
}: {
  onDelete: () => void;
  label: string;
  /** Long-pressing the row starts a reorder instead of a swipe. */
  onDragStart?: () => void;
  onDragMove?: (dy: number) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
  /** Read-only row: hand the card straight through, no gesture on it. */
  disabled?: boolean;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);

  /** Travel before the row comes loose, and how far it may creep in that time. */
  const TENSION_PX = 60;
  const TENSION_MAX_PX = 20;
  /** Past this fraction of the row, letting go deletes. */
  const COMMIT_FRACTION = 0.35;
  /** The reveal's icon has faded fully in by the time it is this wide. */
  const REVEAL_FADE_PX = 56;

  // Everything below runs off the animation loop and writes to the DOM
  // directly. Re-rendering React on every frame of a drag is the one thing
  // guaranteed to make it feel cheap.
  const anim = useRef({
    x: 0,
    v: 0,
    target: 0,
    stiffness: 0,
    damping: 0,
    raf: 0,
    last: 0,
    /** Set while the row is flying off; the spring is not in charge then. */
    fling: null as null | { from: number; to: number; start: number; ms: number },
  });
  const gesture = useRef({
    startX: 0,
    startY: 0,
    axis: 'none' as 'none' | 'x' | 'y',
    acc: 0,
    phase: 'idle' as 'idle' | 'tension' | 'free',
    committed: false,
    mode: 'idle' as 'idle' | 'swipe' | 'drag',
  });
  const holdTimer = useRef<number | null>(null);
  const callbacks = useRef({ onDragStart, onDragMove, onDragEnd, onDelete });
  callbacks.current = { onDragStart, onDragMove, onDragEnd, onDelete };

  const width = () => boxRef.current?.offsetWidth ?? 320;
  const commitPx = () => width() * COMMIT_FRACTION;

  /** Paints the current offset: the row's transform and the reveal's width. */
  const paint = (x: number) => {
    const fg = fgRef.current;
    const bg = bgRef.current;
    if (fg) fg.style.transform = x === 0 ? '' : `translateX(${x}px)`;
    if (!bg) return;
    const shown = Math.abs(x);
    bg.style.width = `${shown}px`;
    if (shown === 0) {
      bg.style.opacity = '0';
      return;
    }
    bg.style.opacity = '1';
    bg.dataset.dir = x > 0 ? 'right' : 'left';
    if (innerRef.current) {
      innerRef.current.style.opacity = String(Math.min(1, shown / REVEAL_FADE_PX));
    }
  };

  const step = () => {
    const a = anim.current;
    const now = performance.now();
    const elapsed = Math.min(64, now - a.last);
    a.last = now;

    if (a.fling) {
      const t = Math.min(1, (now - a.fling.start) / a.fling.ms);
      // Fast-out-slow-in, the same curve the reference tween uses.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      a.x = a.fling.from + (a.fling.to - a.fling.from) * eased;
      paint(a.x);
      if (t >= 1) {
        a.fling = null;
        a.raf = 0;
        return;
      }
      a.raf = requestAnimationFrame(step);
      return;
    }

    // Semi-implicit Euler, sub-stepped: a stiff spring is unstable at 60 Hz in
    // one go, and "stiff" is exactly what a 1:1 follow needs.
    const steps = Math.max(1, Math.ceil((elapsed / 1000) * 240));
    const dt = elapsed / 1000 / steps;
    for (let i = 0; i < steps; i++) {
      const accel = -a.stiffness * (a.x - a.target) - a.damping * a.v;
      a.v += accel * dt;
      a.x += a.v * dt;
    }
    if (Math.abs(a.x - a.target) < 0.25 && Math.abs(a.v) < 2) {
      a.x = a.target;
      a.v = 0;
      paint(a.x);
      a.raf = 0;
      return;
    }
    paint(a.x);
    a.raf = requestAnimationFrame(step);
  };

  /** dampingRatio 1 = no bounce; below that it overshoots. */
  const springTo = (target: number, stiffness: number, dampingRatio: number) => {
    const a = anim.current;
    a.target = target;
    a.stiffness = stiffness;
    a.damping = 2 * dampingRatio * Math.sqrt(stiffness);
    if (!a.raf) {
      a.last = performance.now();
      a.raf = requestAnimationFrame(step);
    }
  };

  const snapTo = (x: number) => {
    const a = anim.current;
    a.x = x;
    a.v = 0;
    a.target = x;
    paint(x);
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;

    const cancelHold = () => {
      if (holdTimer.current) window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    };

    const onStart = (e: TouchEvent) => {
      // A day trip's row sits inside its stop's row: without this, swiping the
      // day trip would drag the whole stop along with it.
      e.stopPropagation();
      const t = e.touches[0]!;
      const g = gesture.current;
      g.startX = t.clientX;
      g.startY = t.clientY;
      g.axis = 'none';
      g.acc = 0;
      g.phase = 'idle';
      g.committed = false;
      g.mode = 'idle';
      if (!callbacks.current.onDragStart) return;
      cancelHold();
      // Hold still for a moment and the row comes up for reordering; move first
      // and it is a swipe or a scroll instead.
      holdTimer.current = window.setTimeout(() => {
        if (gesture.current.mode !== 'idle') return;
        gesture.current.mode = 'drag';
        haptic('long-press');
        callbacks.current.onDragStart?.();
      }, 380);
    };

    const onMove = (e: TouchEvent) => {
      e.stopPropagation();
      const g = gesture.current;
      const t = e.touches[0]!;
      const moveX = t.clientX - g.startX;
      const moveY = t.clientY - g.startY;

      if (g.mode === 'drag') {
        e.preventDefault();
        callbacks.current.onDragMove?.(moveY);
        return;
      }
      // Decide once whether this is a swipe or a scroll, then stick to it —
      // re-deciding mid-gesture makes the row twitch while you scroll past it.
      if (g.axis === 'none') {
        if (Math.abs(moveX) < 10 && Math.abs(moveY) < 10) return;
        cancelHold();
        g.axis = Math.abs(moveX) > Math.abs(moveY) ? 'x' : 'y';
        if (g.axis === 'x') {
          g.mode = 'swipe';
          g.phase = 'tension';
        }
      }
      if (g.axis !== 'x') return;
      e.preventDefault();
      g.acc = moveX;
      const dir = Math.sign(g.acc);

      if (g.phase === 'tension') {
        if (Math.abs(g.acc) < TENSION_PX) {
          snapTo(dir * TENSION_MAX_PX * (Math.abs(g.acc) / TENSION_PX));
          return;
        }
        // Comes loose: spring up to the finger rather than jumping to it.
        haptic('threshold-on');
        g.phase = 'free';
        springTo(g.acc, 200, 0.8);
        return;
      }

      const past = Math.abs(g.acc) > commitPx();
      if (past !== g.committed) {
        g.committed = past;
        haptic(past ? 'threshold-on' : 'threshold-off');
        boxRef.current?.setAttribute('data-armed', String(past));
      }
      springTo(g.acc, 10_000, 1);
    };

    const onEnd = (e: TouchEvent) => {
      e.stopPropagation();
      cancelHold();
      const g = gesture.current;
      if (g.mode === 'drag') {
        g.mode = 'idle';
        callbacks.current.onDragEnd?.();
        return;
      }
      const committed = g.axis === 'x' && Math.abs(g.acc) > commitPx();
      g.mode = 'idle';
      g.axis = 'none';
      g.phase = 'idle';
      g.committed = false;
      boxRef.current?.setAttribute('data-armed', 'false');

      if (committed) {
        haptic('end');
        const dir = Math.sign(g.acc);
        const a = anim.current;
        a.fling = {
          from: a.x,
          to: dir * width() * 1.1,
          start: performance.now(),
          ms: 260,
        };
        if (!a.raf) {
          a.last = performance.now();
          a.raf = requestAnimationFrame(step);
        }
        // Fired now, not after the fling: the row's height collapses in step
        // with it, so the gap closes as it glides away.
        callbacks.current.onDelete();
        return;
      }
      // Cancelled: an elastic settle back to where it was.
      springTo(0, 1500, 0.75);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      cancelHold();
      if (anim.current.raf) cancelAnimationFrame(anim.current.raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing to swipe away and nothing to reorder: the card is the whole row.
  if (disabled) return <>{children}</>;

  return (
    <div className="swipe-row" ref={boxRef} data-dragging={dragging} data-armed="false">
      {/* Grows out of the edge you are uncovering; the icon hugs that edge and
          the label sits a fixed distance inward, so both directions read the
          same way round. */}
      <div className="swipe-reveal" ref={bgRef} aria-hidden="true">
        <span className="swipe-reveal-inner" ref={innerRef}>
          <Icon name="trash" size={18} className="swipe-reveal-icon" />
          <span className="swipe-reveal-label">{label}</span>
        </span>
      </div>
      <div className="swipe-fg" ref={fgRef}>
        {children}
      </div>
      {/* Mouse-and-keyboard fallback: there is no swipe on a desktop, and the
          card's own drag gesture is already taken by reordering. */}
      <button type="button" className="swipe-x" aria-label={label} onClick={onDelete}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}


/**
 * The day trips hanging off one stop, plus the panel to add another.
 *
 * Visually it is a branch: a line drops out of the stop's photo and forks right
 * to each day trip, so a second and third excursion simply extend the same
 * line instead of looking like new stops in the route.
 */
function DayTrips({
  parent,
  dayTrips,
  open,
  removingId,
  onClose,
  onAdd,
  onDate,
  onRemove,
  readOnly,
  pin,
  countryCode,
  suggestedName,
  onPickPlace,
  onPlaceOnMap,
  editingId,
  onEdit,
  renderEdit,
}: {
  parent: PlannedStop;
  dayTrips: PlannedStop[];
  open: boolean;
  removingId: string | null;
  onClose: () => void;
  /** The name as typed or picked; the place comes from the pin. */
  onAdd: (name: string, day: string) => void;
  onDate: (dayTrip: PlannedStop, day: string) => void;
  onRemove: (stop: PlannedStop) => void;
  readOnly?: boolean;
  /** Where the new day trip's pin stands, and the country under it. */
  pin: { lat: number; lng: number } | null;
  countryCode: string | null;
  /** A name for where the pin was dropped; fills the field only while empty. */
  suggestedName: string | null;
  /** A search result chosen (the pin moves there), or null to take it away. */
  onPickPlace: (place: PlaceSuggestion | null) => void;
  onPlaceOnMap?: () => void;
  /** The stop or day trip whose name and place are open for editing. */
  editingId: string | null;
  onEdit: (dayTrip: PlannedStop) => void;
  renderEdit: (dayTrip: PlannedStop) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [sugg, setSugg] = useState<PlaceSuggestion[]>([]);
  const [picked, setPicked] = useState<PlaceSuggestion | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Defaults to the day you arrive at the stop — the usual answer, and it opens
  // the calendar on the right month straight away.
  const [day, setDay] = useState(parent.arrivalDate.slice(0, 10));
  const timer = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the form every time the panel opens, and put the caret in the search
  // box so you can start typing right away.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSugg([]);
    setPicked(null);
    setNotFound(false);
    setDay(parent.arrivalDate.slice(0, 10));
    // After the 0.32s expander has settled, so the field is where it will stay
    // when the keyboard-scroll handler measures it.
    const t = window.setTimeout(() => inputRef.current?.focus(), 340);
    return () => window.clearTimeout(t);
  }, [open, parent.arrivalDate]);

  // A name for where the pin landed, while there is none of your own yet.
  useEffect(() => {
    if (open && suggestedName) setQuery((current) => (current.trim() ? current : suggestedName));
  }, [open, suggestedName]);

  // The pin still where the picked result put it? Then it is that place.
  const fromSearch =
    picked !== null && pin !== null && pin.lat === picked.latitude && pin.lng === picked.longitude;

  // A spot pointed at on the map answers the search; the list can go.
  useEffect(() => {
    if (pin && !fromSearch) {
      setSugg([]);
      setNotFound(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.lat, pin?.lng]);

  function onInput(value: string) {
    setQuery(value);
    setNotFound(false);
    // Same rule as a new stop: a found place goes with its name, a spot you
    // pointed at on the map stays whatever you call it.
    if (fromSearch) onPickPlace(null);
    setPicked(null);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      searchPlaces(value, controller.signal, { anyPlace: true })
        .then((found) => {
          setSugg(found);
          setNotFound(found.length === 0 && value.trim().length >= 3);
        })
        .catch(() => undefined);
    }, 280);
  }

  function pick(place: PlaceSuggestion) {
    setPicked(place);
    setQuery(place.name);
    setSugg([]);
    setNotFound(false);
    onPickPlace(place);
  }

  return (
    <>
      {dayTrips.length > 0 && (
        <ul className="daytrips">
          {dayTrips.map((trip) => (
            <li
              key={trip.id}
              className={`daytrip-row ${removingId === trip.id ? 'leaving' : ''}`}
            >
                <div className="daytrip-card">
                  <CityThumb
                    name={trip.name}
                    index={-1}
                    countryCode={trip.countryCode}
                    className="daytrip-thumb"
                  />
                  <div className="daytrip-info">
                    <span className="stop-name-row">
                      <strong>{trip.name}</strong>
                      {!readOnly && (
                        <button
                          type="button"
                          className={`stop-edit-btn ${editingId === trip.id ? 'open' : ''}`}
                          aria-label={`${trip.name} bewerken`}
                          aria-expanded={editingId === trip.id}
                          onClick={() => onEdit(trip)}
                        >
                          <Icon name="pencil" size={12} />
                        </button>
                      )}
                    </span>
                    <span className="muted daytrip-meta">
                      {readOnly ? (
                        formatDate(trip.arrivalDate)
                      ) : (
                        <DateField
                          value={trip.arrivalDate.slice(0, 10)}
                          nearDate={parent.arrivalDate.slice(0, 10)}
                          onChange={(value) => value && onDate(trip, value)}
                        />
                      )}
                      {trip.latitude !== null && trip.longitude !== null && (
                        <WeatherBadge
                          lat={trip.latitude}
                          lon={trip.longitude}
                          day={trip.arrivalDate}
                          separator
                        />
                      )}
                    </span>
                  </div>
                  {/* A day trip keeps its cross: the rows are small, and a swipe
                      on something this size is fiddly. */}
                  {!readOnly && (
                    <button
                      type="button"
                      className="daytrip-delete"
                      onClick={() => onRemove(trip)}
                      aria-label="Dagtrip verwijderen"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>
                {!readOnly && renderEdit(trip)}
            </li>
          ))}
        </ul>
      )}

      {/* 0fr → 1fr expander: the card itself grows, so the panel unfolds out of
          the stop instead of appearing on top of it. */}
      {!readOnly && (
      <div className="daytrip-panel" data-open={open}>
        <div className="daytrip-panel-inner">
          <div className="daytrip-form">
            <div className="daytrip-search searchbox">
              <Icon name="search" size={15} />
              <input
                ref={inputRef}
                value={query}
                placeholder={`Waar ging je heen vanuit ${parent.name}?`}
                onChange={(e) => onInput(e.target.value)}
              />
            </div>
            {sugg.length > 0 && (
              <ul className="daytrip-suggestions">
                {sugg.map((place, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => pick(place)}>
                      <Flag code={place.countryCode} size={17} />
                      <span>
                        <strong>{place.name}</strong>
                        {place.region && <small> {place.region}</small>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {notFound && !pin && (
              <p className="stop-notfound">
                Niet gevonden? Houd de naam zoals je hem typte en{' '}
                <button type="button" className="link-btn" onClick={onPlaceOnMap}>
                  duid de plek aan op de kaart
                </button>
                .
              </p>
            )}
            <PlaceLine
              pin={pin}
              countryCode={countryCode}
              fromSearch={fromSearch}
              onPlaceOnMap={onPlaceOnMap}
              onClear={() => {
                setPicked(null);
                onPickPlace(null);
              }}
            />
            <div className="daytrip-when">
              <DateField
                label="Welke dag?"
                value={day}
                nearDate={parent.arrivalDate.slice(0, 10)}
                onChange={setDay}
              />
            </div>
            <div className="daytrip-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Annuleren
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!query.trim() || !day}
                onClick={() => onAdd(query, day)}
              >
                Toevoegen
              </button>
            </div>
          </div>
        </div>
      </div>
      )}
    </>
  );
}

/** Origin/destination picker for a standalone heen-/terugreis leg (any non-flight
 *  mode). Purely so the driven kilometres of that leg count toward the trip
 *  distance — the place you leave from / return to. */
function LegLocation({
  outbound,
  hasLocation,
  savedLabel,
  onSave,
  onFlyTo,
  readOnly,
}: {
  outbound: boolean;
  hasLocation: boolean;
  readOnly?: boolean;
  savedLabel?: string | null;
  onSave: (data: {
    latitude: number;
    longitude: number;
    countryCode?: string;
    notes?: string;
  }) => void;
  onFlyTo: (lng: number, lat: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<string | null>(null);

  function pick(p: PlaceSuggestion) {
    setLabel(p.name);
    setOpen(false);
    onFlyTo(p.longitude, p.latitude);
    onSave({
      latitude: p.latitude,
      longitude: p.longitude,
      countryCode: p.countryCode,
      notes: p.name, // remembered so the pill shows the place name, not "Ingesteld"
    });
  }

  // The chosen place name (this session), else the persisted one, else a prompt.
  const name = label ?? savedLabel ?? null;
  const text = name ?? (hasLocation ? 'Ingesteld' : outbound ? 'Beginpunt' : 'Eindpunt');
  const isSet = hasLocation || !!label;

  // Nothing set and nothing to set: an empty "Beginpunt" prompt is an
  // invitation, and a guest has no way to accept it.
  if (readOnly && !isSet) return null;

  return (
    <>
      <button
        type="button"
        className={`leg-loc-pill ${isSet ? 'set' : ''}`}
        disabled={readOnly}
        onClick={() => setOpen(true)}
      >
        <Icon name="pin" size={13} />
        <span className="leg-loc-text">{text}</span>
      </button>
      {open && (
        <PlaceSheet
          title={outbound ? 'Vertrek vanaf' : 'Terug naar'}
          placeholder={outbound ? 'Vanaf welke plaats?' : 'Naar welke plaats?'}
          onClose={() => setOpen(false)}
          onPick={pick}
        />
      )}
    </>
  );
}

/** Place search in the same sliding sheet as the flight editor, so it animates
 *  in and out and the keyboard never fights the map behind it. */
function PlaceSheet({
  title,
  placeholder,
  onClose,
  onPick,
}: {
  title: string;
  placeholder: string;
  onClose: () => void;
  onPick: (place: PlaceSuggestion) => void;
}) {
  const [query, setQuery] = useState('');
  const [sugg, setSugg] = useState<PlaceSuggestion[]>([]);
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const close = () => {
    setClosing(true);
    window.setTimeout(onClose, 200);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    // Back closes the sheet rather than leaving the planner.
    window.history.pushState({ mmsPlace: true }, '');
    let popped = false;
    const onPop = () => {
      popped = true;
      close();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      if (!popped) window.history.back();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onInput(v: string) {
    setQuery(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      abort.current?.abort();
      const c = new AbortController();
      abort.current = c;
      searchPlaces(v, c.signal).then(setSugg).catch(() => undefined);
    }, 280);
  }

  return createPortal(
    <div className={`fe-layer ${closing ? 'closing' : ''}`}>
      <div className="fe-scrim" onClick={close} />
      <div className="fe-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="fe-grab" aria-hidden="true" />
        <header className="fe-head">
          <strong>{title}</strong>
          <button type="button" className="fe-icon-btn" aria-label="Sluiten" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="fe-picker-search searchbox">
          <Icon name="search" size={16} />
          <input
            autoFocus
            value={query}
            placeholder={placeholder}
            onChange={(e) => onInput(e.target.value)}
          />
        </div>
        <ul className="fe-picker-list">
          {sugg.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => onPick(p)}>
                <span className="fe-picker-code">
                  <Flag code={p.countryCode} size={20} />
                </span>
                <span className="fe-picker-name">
                  <strong>{p.name}</strong>
                  {p.region && <small>{p.region}</small>}
                </span>
              </button>
            </li>
          ))}
          {query.trim() && sugg.length === 0 && (
            <li className="fe-picker-empty">Niets gevonden.</li>
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Distance + travel time on a leg. Shows them together when they fit; when the
 * pair is too wide for the row it falls back to alternating between the two
 * every few seconds. Fit is measured with a hidden probe carrying the full
 * text, so the check doesn't flip-flop once the short version is displayed.
 */
function AltMetric({ km, mode }: { km: number; mode: TravelMode }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [alternate, setAlternate] = useState(false);
  const [showDur, setShowDur] = useState(false);

  const distance = `${km.toLocaleString('nl-NL')} km`;
  const duration = estimateDuration(km, mode);
  const full = `${distance} · ${duration}`;

  useEffect(() => {
    const box = boxRef.current;
    const probe = probeRef.current;
    if (!box || !probe) return;
    const measure = () => setAlternate(probe.offsetWidth > box.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [full]);

  useEffect(() => {
    if (!alternate) return;
    const t = window.setInterval(() => setShowDur((v) => !v), 3000);
    return () => window.clearInterval(t);
  }, [alternate]);

  return (
    <span className="leg-alt-metric" ref={boxRef} title={full}>
      <span className="leg-alt-metric-probe" ref={probeRef} aria-hidden="true">
        {full}
      </span>
      <span key={alternate ? (showDur ? 'd' : 'k') : 'full'} className="leg-alt-metric-val">
        {alternate ? (showDur ? duration : distance) : full}
      </span>
    </span>
  );
}

/** A pill with a dropdown to pick a travel mode (car/train/bus/boat/flight).
 *  Used to add an outbound/return leg, and to change a standalone leg's mode. */
function ModeMenu({
  label,
  current,
  compact,
  align = 'left',
  onPick,
  readOnly,
}: {
  label?: string;
  current?: TravelMode;
  compact?: boolean;
  align?: 'left' | 'right';
  onPick: (mode: TravelMode) => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = () => {
    setClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 140);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const icon = current ? MODE_ICON[current] ?? 'car' : 'plus';
  const text = label ?? MODE_LABEL[current!];

  return (
    <div
      className={`mode-menu ${compact ? 'mode-menu-compact' : ''} ${
        readOnly ? 'mode-menu-static' : ''
      }`}
      ref={ref}
    >
      <button
        type="button"
        className="mode-menu-pill"
        disabled={readOnly}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {/* Keyed on the mode so picking another one cross-fades icon + label
            instead of swapping them instantly. */}
        <span className="mode-menu-face" key={current ?? 'new'}>
          <Icon name={icon} size={compact ? 14 : 16} />
          <span>{text}</span>
        </span>
        {/* No caret when there is no menu behind it: the pill is a label. */}
        {!readOnly && <Icon name="chevron-down" size={13} className="mode-menu-caret" />}
      </button>
      {open && (
        <div className={`mode-menu-drop card mode-menu-${align} ${closing ? 'closing' : ''}`}>
          {TRAVEL_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={current === m ? 'active' : ''}
              // close(), not setOpen(false): picking one is the same gesture
              // as tapping away, and it used to skip the exit and simply
              // vanish while the other way out played its animation.
              onClick={() => {
                onPick(m);
                close();
              }}
            >
              <Icon name={MODE_ICON[m] ?? 'car'} size={16} />
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Where a stop is going to be, said in words, with the way to set it by hand.
 *
 * The map tap for a stop's place used to be a grey line of coordinates under
 * the form: there was no pin to see, so nobody knew the tap had done anything,
 * or that it could be done at all. Now it is a button, and what it chose is a
 * pin on the map you can drag and a line here you can take back.
 */
function PlaceLine({
  pin,
  countryCode,
  fromSearch,
  onPlaceOnMap,
  onClear,
}: {
  pin: { lat: number; lng: number } | null;
  countryCode: string | null;
  fromSearch: boolean;
  onPlaceOnMap?: () => void;
  onClear?: () => void;
}) {
  return (
    <div className={`place-line ${pin ? 'has-pin' : ''}`}>
      <span className="place-line-text">
        {pin ? (
          <>
            {countryCode ? <Flag code={countryCode} size={15} /> : <Icon name="pin" size={15} />}
            {fromSearch ? 'Plek uit de zoekresultaten' : 'Plek aangeduid op de kaart'}
            <small>· sleep de pin om bij te stellen</small>
          </>
        ) : (
          <>
            <Icon name="pin" size={15} />
            Nog geen plek (optioneel)
          </>
        )}
      </span>
      <span className="place-line-actions">
        {onPlaceOnMap && (
          <button type="button" className="btn btn-ghost place-line-btn" onClick={onPlaceOnMap}>
            <Icon name="pin" size={14} />
            {pin ? 'Toon op kaart' : 'Aanduiden op kaart'}
          </button>
        )}
        {pin && onClear && (
          <button
            type="button"
            className="place-line-clear"
            aria-label="Plek wissen"
            onClick={onClear}
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * A stop's name and place, changed in place.
 *
 * The search does not know every town by the name a traveller uses, and it
 * sometimes picks the wrong one of two. Deleting the stop and adding it again
 * lost its nights, its day trips and its spot in the route; this keeps all of
 * that and changes only what was wrong. It unfolds inside the card rather than
 * over the page, so the map stays free to tap and the pin free to drag.
 */
/**
 * Notes for one stop: the hotel, the booking, what not to miss. They go out
 * with the share link, under the stop, as Markdown.
 *
 * Folded away until asked for, so a plan without notes looks as it did. It
 * saves when you leave the field, like the day stories.
 */
function StopNotes({ notes, onSave }: { notes: string | null; onSave: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(notes ?? '');
  useEffect(() => setDraft(notes ?? ''), [notes]);

  return (
    <div className="stop-notes">
      <button
        type="button"
        className={`daytrip-btn stop-notes-toggle ${open ? 'open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="pencil" size={13} />
        {notes ? 'Notitie' : 'Notitie toevoegen'}
      </button>
      {!open && notes && <p className="stop-notes-preview muted">{notes}</p>}
      {open && (
        <textarea
          className="stop-notes-input"
          rows={3}
          maxLength={2000}
          autoFocus
          value={draft}
          placeholder="Hotel, reservatie, tips… Markdown werkt: **vet**, lijstjes, [link](https://…)"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onSave(draft)}
        />
      )}
    </div>
  );
}

function StopEdit({
  stop,
  open,
  pin,
  countryCode,
  onPlaceOnMap,
  onPickPlace,
  onCancel,
  onSave,
}: {
  stop: PlannedStop;
  open: boolean;
  pin: { lat: number; lng: number } | null;
  countryCode: string | null;
  onPlaceOnMap?: () => void;
  /** A search result chosen: the pin moves there. */
  onPickPlace: (place: PlaceSuggestion) => void;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(stop.name);
  const [sugg, setSugg] = useState<PlaceSuggestion[]>([]);
  const [picked, setPicked] = useState<PlaceSuggestion | null>(null);
  const [notFound, setNotFound] = useState(false);
  const timer = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(stop.name);
    setSugg([]);
    setPicked(null);
    setNotFound(false);
    const t = window.setTimeout(() => inputRef.current?.select(), 340);
    return () => window.clearTimeout(t);
  }, [open, stop.name]);

  // Whether the pin still stands where the picked search result put it: move
  // it on the map and it is your own spot again.
  const fromSearch =
    picked !== null && pin !== null && pin.lat === picked.latitude && pin.lng === picked.longitude;

  function onInput(value: string) {
    setName(value);
    setPicked(null);
    setNotFound(false);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      searchPlaces(value, controller.signal, { anyPlace: true })
        .then((found) => {
          setSugg(found);
          setNotFound(found.length === 0 && value.trim().length >= 3);
        })
        .catch(() => undefined);
    }, 280);
  }

  function pick(place: PlaceSuggestion) {
    setPicked(place);
    setName(place.name);
    setSugg([]);
    setNotFound(false);
    onPickPlace(place);
  }

  return (
    <div className="daytrip-panel stop-edit" data-open={open}>
      <div className="daytrip-panel-inner">
        <form
          className="daytrip-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSave(name);
          }}
        >
          <label className="stop-edit-label" htmlFor={`stop-edit-${stop.id}`}>
            Naam
          </label>
          <div className="daytrip-search searchbox">
            <Icon name="pencil" size={15} />
            <input
              id={`stop-edit-${stop.id}`}
              ref={inputRef}
              value={name}
              maxLength={120}
              autoComplete="off"
              placeholder="Naam van de stop"
              onChange={(e) => onInput(e.target.value)}
            />
          </div>
          {sugg.length > 0 && (
            <ul className="daytrip-suggestions">
              {sugg.map((place, i) => (
                <li key={i}>
                  <button type="button" onClick={() => pick(place)}>
                    <Flag code={place.countryCode} size={17} />
                    <span>
                      <strong>{place.name}</strong>
                      {place.region && <small> {place.region}</small>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {notFound && (
            <p className="stop-notfound">
              Niet gevonden — de naam mag zo blijven. Zet de plek zelf op de kaart.
            </p>
          )}
          <PlaceLine
            pin={pin}
            countryCode={countryCode}
            fromSearch={fromSearch}
            onPlaceOnMap={onPlaceOnMap}
          />
          <div className="daytrip-actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Annuleren
            </button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              Opslaan
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
