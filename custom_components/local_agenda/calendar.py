"""Calendar platform for local_agenda."""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

import recurring_ical_events
from icalendar import Calendar, Event, vDate, vDatetime, vRecur
from homeassistant.components.calendar import (
    CalendarEntity,
    CalendarEntityFeature,
    CalendarEvent,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN, CONF_CALENDAR_NAME
from .store import LocalAgendaStore

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the calendar platform from a config entry."""
    store: LocalAgendaStore = hass.data[DOMAIN][config_entry.entry_id]["store"]
    name = config_entry.data.get(CONF_CALENDAR_NAME, "Local Agenda")

    entity = LocalAgendaEntity(hass, store, name, config_entry.entry_id)
    async_add_entities([entity], True)

    # Register for the action scheduler in __init__.py
    hass.data[DOMAIN][config_entry.entry_id].setdefault("entities", []).append(entity)


class LocalAgendaEntity(CalendarEntity):
    """Representation of a Local Agenda calendar."""

    _attr_icon = "mdi:calendar-clock"
    _attr_supported_features = (
        CalendarEntityFeature.CREATE_EVENT
        | CalendarEntityFeature.DELETE_EVENT
        | CalendarEntityFeature.UPDATE_EVENT
    )

    def __init__(
        self,
        hass: HomeAssistant,
        store: LocalAgendaStore,
        name: str,
        entry_id: str,
    ) -> None:
        """Initialise the entity."""
        self._hass = hass
        self._store = store
        self._attr_name = name
        self._attr_unique_id = f"local_agenda_{entry_id}"
        self._entry_id = entry_id
        # Cache for the next upcoming event — updated in async_update and after CRUD
        self._next_event: CalendarEvent | None = None

    async def async_added_to_hass(self) -> None:
        """Initialize cache when entity is added."""
        await self._refresh_next_event()

    # ------------------------------------------------------------------
    # CalendarEntity required properties
    # ------------------------------------------------------------------

    @property
    def event(self) -> CalendarEvent | None:
        """Return the next upcoming event from cache — always instant."""
        return self._next_event

    async def async_update(self) -> None:
        """Called periodically by HA to refresh state — update the cache."""
        await self._refresh_next_event()

    async def _refresh_next_event(self) -> None:
        """Recompute the next upcoming event in the executor (non-blocking).

        Look a week ahead first and widen only when nothing is found: the
        earliest event of a short window is also the earliest of a longer
        one, and expanding a whole year of recurrences on every refresh is
        wasted work for a calendar that has something planned this week.
        """
        now = dt_util.utcnow()
        for days in _NEXT_EVENT_HORIZONS_DAYS:
            events = await self._hass.async_add_executor_job(
                self._expand_events, now, now + timedelta(days=days)
            )
            if events:
                self._next_event = events[0]
                return
        self._next_event = None

    def _notify_panel_updated(self) -> None:
        """Fire a bus event so the Local Agenda panel can refresh its event
        list immediately. Needed because async_write_ha_state() alone is not
        a reliable signal for the frontend panel: HA skips updating the
        entity's state/last_updated when neither the visible state string
        nor its attributes actually changed (e.g. deleting an event that
        wasn't the "next upcoming" one shown by the entity). The panel
        subscribes to this event directly instead of polling entity state.
        """
        self._hass.bus.async_fire(f"{DOMAIN}_updated", {"entry_id": self._entry_id})

    async def async_get_events(
        self,
        hass: HomeAssistant,
        start_date: datetime,
        end_date: datetime,
    ) -> list[CalendarEvent]:
        """Return events within the provided time range."""
        return await hass.async_add_executor_job(
            self._expand_events, start_date, end_date
        )

    def _expand_events(
        self, start_date: datetime, end_date: datetime
    ) -> list[CalendarEvent]:
        """Expand all events in range.

        The whole calendar is expanded in one pass.  Only if that fails —
        one malformed event is enough — each UID group (master VEVENT plus
        its RECURRENCE-ID exceptions, RFC 5545 §3.8.4.4) is expanded on its
        own, so that a single bad event never hides the others.
        """
        cal = _safe_calendar(self._store.get_calendar_for_read())

        # Group VEVENTs by UID, and remember the RRULE of each master.
        # recurring_ical_events does NOT copy RRULE onto the occurrences it
        # returns, so it is carried forward for CalendarEvent.rrule (the HA
        # dialog would otherwise show every recurring event as "never").
        events_by_uid: dict[str, list] = defaultdict(list)
        rrule_by_uid: dict[str, str] = {}
        for vevent in cal.subcomponents:
            if vevent.name != "VEVENT":
                continue
            uid = str(vevent.get("UID", "_no_uid_"))
            events_by_uid[uid].append(vevent)
            if vevent.get("RECURRENCE-ID") is None:
                rrule_str = _rrule_to_str(vevent.get("RRULE"))
                if rrule_str is not None:
                    rrule_by_uid[uid] = rrule_str

        def _convert(occurrences: list) -> list[CalendarEvent]:
            converted = []
            for occ in occurrences:
                uid = str(occ.get("UID", "_no_uid_"))
                evt = _component_to_event(occ, rrule_override=rrule_by_uid.get(uid))
                if evt is not None:
                    converted.append(evt)
            return converted

        try:
            events = _convert(
                recurring_ical_events.of(cal, components=["VEVENT"]).between(
                    start_date, end_date
                )
            )
        except Exception as err:
            _LOGGER.debug(
                "local_agenda: whole-calendar expansion failed (%s) — "
                "expanding each event separately", err,
            )
            events = self._expand_events_by_uid(
                cal, events_by_uid, _convert, start_date, end_date
            )

        events.sort(key=lambda e: _as_utc(e.start))
        return events

    @staticmethod
    def _expand_events_by_uid(
        cal: Calendar,
        events_by_uid: dict[str, list],
        convert: Any,
        start_date: datetime,
        end_date: datetime,
    ) -> list[CalendarEvent]:
        """Expand each UID group in its own mini calendar (fallback path)."""
        # Non-VEVENT components (VTIMEZONE, etc.) are shared by every group.
        base_subcomponents = [c for c in cal.subcomponents if c.name != "VEVENT"]
        events: list[CalendarEvent] = []
        for uid, vevents in events_by_uid.items():
            mini = Calendar()
            for key in cal:
                mini[key] = cal[key]
            mini.subcomponents = base_subcomponents + vevents
            try:
                events.extend(
                    convert(
                        recurring_ical_events.of(mini, components=["VEVENT"]).between(
                            start_date, end_date
                        )
                    )
                )
            except Exception as err:
                _LOGGER.warning(
                    "local_agenda: skipping uid=%s (%s): %s",
                    uid, vevents[0].get("SUMMARY", "?"), err,
                )
        return events

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def _async_saved(self) -> None:
        """Persist the calendar and publish the change."""
        await self._store.async_save(self._hass)
        await self._refresh_next_event()
        self.async_write_ha_state()
        self._notify_panel_updated()

    async def async_create_event(self, **kwargs: Any) -> None:
        """Create a new event (called by HA frontend)."""
        _LOGGER.debug("local_agenda: create_event kwargs keys=%s", list(kwargs.keys()))
        # Normalise start/end — HA may use dtstart OR start_date_time/start_date
        start = (kwargs.get("dtstart") or kwargs.get("start_date_time")
                 or kwargs.get("start_date"))
        end   = (kwargs.get("dtend")   or kwargs.get("end_date_time")
                 or kwargs.get("end_date") or start)
        if start is None:
            raise HomeAssistantError(
                "local_agenda: cannot create an event without a start date/time"
            )
        rrule = _parse_rrule(kwargs.get("rrule"))

        component = Event()
        component.add("uid", str(uuid.uuid4()))
        component.add("dtstamp", dt_util.utcnow())
        component.add("summary", kwargs.get("summary", ""))
        component.add("dtstart", start)
        component.add("dtend", end)
        if desc := kwargs.get("description"):
            component.add("description", desc)
        if loc := kwargs.get("location"):
            component.add("location", loc)
        if rrule is not None:
            component.add("rrule", rrule)
        self._store.get_calendar().add_component(component)
        await self._async_saved()

    async def async_delete_event(
        self,
        uid: str,
        recurrence_id: str | None = None,
        recurrence_range: str | None = None,
    ) -> None:
        """Delete an event or one of its occurrences.

        - No recurrence_id  → delete the whole series (or the single event).
        - recurrence_id set, range THISANDFUTURE → truncate series at that date.
        - recurrence_id set, no range (THIS)     → exclude that occurrence via EXDATE.
        """
        _LOGGER.debug(
            "local_agenda: delete_event uid=%s recurrence_id=%s range=%s",
            uid, recurrence_id, recurrence_range,
        )
        cal = self._store.get_calendar()
        master = _find_master(cal, uid)
        if master is None and not _has_uid(cal, uid):
            raise HomeAssistantError(f"local_agenda: event {uid} not found")

        # HA's native calendar UI sends a recurrence_id (matching DTSTART)
        # even when deleting a perfectly ordinary, non-recurring event.  With
        # no RRULE there is no series to exclude an occurrence from — an
        # EXDATE would be a silent no-op and the event would keep appearing —
        # so the whole VEVENT is deleted, exactly as if recurrence_id were None.
        if recurrence_id is None or (
            master is not None and master.get("rrule") is None
        ):
            _remove_uid(cal, uid)
        else:
            rec_dt = _recurrence_dt(recurrence_id, master)
            if rec_dt is None:
                raise HomeAssistantError(
                    f"local_agenda: unreadable recurrence id '{recurrence_id}'"
                )
            if recurrence_range == "THISANDFUTURE":
                if master is not None:
                    _truncate_series(cal, master, uid, rec_dt)
            else:
                # Exclude just this occurrence via EXDATE on the master.  A
                # new EXDATE property is always added rather than merged into
                # an existing one — several EXDATE lines are valid per
                # RFC 5545.
                if master is not None:
                    master.add("exdate", rec_dt)
                # Also remove the RECURRENCE-ID override of that occurrence,
                # if any: it would otherwise survive in the file and keep
                # appearing in the calendar despite the EXDATE.
                _remove_overrides(
                    cal, uid, lambda rid: _same_moment(rid, rec_dt)
                )

        await self._async_saved()

    async def async_update_event(
        self,
        uid: str,
        event: dict[str, Any],
        recurrence_id: str | None = None,
        recurrence_range: str | None = None,
    ) -> None:
        """Update an event or one occurrence of a recurring series."""
        _LOGGER.debug(
            "local_agenda: update_event uid=%s recurrence_id=%s range=%s event_keys=%s",
            uid, recurrence_id, recurrence_range, list(event.keys()),
        )
        cal = self._store.get_calendar()
        master = _find_master(cal, uid)
        if master is None:
            raise HomeAssistantError(f"local_agenda: event {uid} not found")

        # Normalise start/end — HA may send dtstart or start_date_time/start_date
        new_start = (event.get("dtstart") or event.get("start_date_time")
                     or event.get("start_date"))
        new_end   = (event.get("dtend")   or event.get("end_date_time")
                     or event.get("end_date"))
        # Validate everything before touching the calendar, so that a
        # rejected edit leaves it exactly as it was.
        new_rrule = _parse_rrule(event.get("rrule"))

        # HA always sends a recurrence_id, even for a non-recurring event.
        # Without an RRULE there is no occurrence to single out: the edit
        # applies to the event itself.
        if recurrence_id is None or master.get("rrule") is None:
            _update_whole_series(cal, master, uid, event, new_start, new_end, new_rrule)
        else:
            rec_dt = _recurrence_dt(recurrence_id, master)
            if rec_dt is None:
                raise HomeAssistantError(
                    f"local_agenda: unreadable recurrence id '{recurrence_id}'"
                )
            if recurrence_range == "THISANDFUTURE":
                _update_this_and_future(
                    cal, master, uid, event, rec_dt, new_start, new_end, new_rrule
                )
            else:
                _update_single_occurrence(
                    cal, master, uid, event, rec_dt, new_start, new_end
                )

        await self._async_saved()


# ------------------------------------------------------------------
# Edit helpers
# ------------------------------------------------------------------

# Successive look-ahead windows used to find the next upcoming event.
_NEXT_EVENT_HORIZONS_DAYS = (7, 60, 365)

_TEXT_FIELDS = ("summary", "description", "location")


def _rrule_to_str(rrule_prop: Any) -> str | None:
    """Return an RRULE property as text, or None."""
    if rrule_prop is None:
        return None
    try:
        return rrule_prop.to_ical().decode("utf-8")
    except Exception:
        return None


def _parse_rrule(rrule: str | None) -> vRecur | None:
    """Parse the RRULE text sent by HA; None when there is none."""
    if not rrule:
        return None
    try:
        return vRecur.from_ical(rrule)
    except Exception as err:
        raise HomeAssistantError(
            f"local_agenda: invalid recurrence rule '{rrule}': {err}"
        ) from err


def _has_uid(cal: Calendar, uid: str) -> bool:
    return any(
        c.name == "VEVENT" and str(c.get("uid", "")) == uid
        for c in cal.subcomponents
    )


def _find_master(cal: Calendar, uid: str) -> Event | None:
    """Return the master VEVENT of a UID (the one without RECURRENCE-ID).

    Exceptions (RECURRENCE-ID VEVENTs) share the same uid but must not be
    confused with the master when modifying RRULE, EXDATE or the times.
    """
    for component in cal.walk("VEVENT"):
        if (str(component.get("uid", "")) == uid
                and component.get("RECURRENCE-ID") is None):
            return component
    return None


def _remove_uid(cal: Calendar, uid: str) -> None:
    """Remove a whole series: the master and all its exceptions."""
    before = len(cal.subcomponents)
    cal.subcomponents = [
        c for c in cal.subcomponents
        if not (c.name == "VEVENT" and str(c.get("uid", "")) == uid)
    ]
    _LOGGER.debug(
        "local_agenda: removed %d component(s) for uid=%s",
        before - len(cal.subcomponents), uid,
    )


def _remove_overrides(cal: Calendar, uid: str, matches: Any) -> None:
    """Remove the RECURRENCE-ID exceptions of a UID whose id satisfies `matches`."""

    def _is_match(c: Any) -> bool:
        if c.name != "VEVENT" or str(c.get("uid", "")) != uid:
            return False
        rid = c.get("RECURRENCE-ID")
        return rid is not None and matches(rid.dt)

    before = len(cal.subcomponents)
    cal.subcomponents = [c for c in cal.subcomponents if not _is_match(c)]
    _LOGGER.debug(
        "local_agenda: removed %d RECURRENCE-ID exception(s) for uid=%s",
        before - len(cal.subcomponents), uid,
    )


def _recurrence_dt(recurrence_id: str, master: Event | None) -> date | datetime | None:
    """Turn the recurrence_id sent by HA into a date or datetime.

    HA sends back the RECURRENCE-ID of the occurrence as iCalendar text.
    For an event stored with a TZID that text is a wall-clock time without
    any timezone ("20261009T143000"): it is expressed in the timezone of the
    master's DTSTART, which is therefore attached to it.  Comparing instants
    is then exact, where dropping the timezone of the other side would
    compare wall-clock times of possibly different zones.
    """
    rec_dt: date | datetime | None = None
    for parser in (vDatetime, vDate):
        try:
            rec_dt = parser.from_ical(recurrence_id)
            break
        except Exception:
            continue
    if (isinstance(rec_dt, datetime) and rec_dt.tzinfo is None
            and master is not None):
        dtstart = master.get("dtstart")
        if (dtstart is not None and isinstance(dtstart.dt, datetime)
                and dtstart.dt.tzinfo is not None):
            rec_dt = rec_dt.replace(tzinfo=dtstart.dt.tzinfo)
    return rec_dt


def _comparable_pair(
    a: date | datetime, b: date | datetime
) -> tuple[datetime, datetime]:
    """Return two values of the same kind, so they can be compared.

    A date becomes midnight.  When only one side has a timezone (a floating
    time in an imported .ics) there is nothing to convert with: both are
    then compared as wall-clock times.
    """
    if not isinstance(a, datetime):
        a = datetime(a.year, a.month, a.day)
    if not isinstance(b, datetime):
        b = datetime(b.year, b.month, b.day)
    if (a.tzinfo is None) != (b.tzinfo is None):
        a = a.replace(tzinfo=None)
        b = b.replace(tzinfo=None)
    return a, b


def _same_moment(a: date | datetime, b: date | datetime) -> bool:
    if isinstance(a, datetime) != isinstance(b, datetime):
        return False  # an all-day value never equals a timed one
    a, b = _comparable_pair(a, b)
    return a == b


def _is_before(a: date | datetime, b: date | datetime) -> bool:
    a, b = _comparable_pair(a, b)
    return a < b


def _apply_text_fields(component: Event, event: dict[str, Any]) -> None:
    """Copy the summary / description / location present in `event`."""
    for field in _TEXT_FIELDS:
        if field not in event:
            continue
        component.pop(field, None)
        value = event[field]
        if field == "summary":
            component.add(field, value or "")
        elif value:
            component.add(field, value)


def _set_times(
    component: Event,
    new_start: date | datetime | None,
    new_end: date | datetime | None,
) -> None:
    if new_start is not None:
        component.pop("dtstart", None)
        component.add("dtstart", new_start)
    if new_end is not None:
        component.pop("dtend", None)
        component.add("dtend", new_end)


def _duration(component: Event) -> timedelta | None:
    """Return DTEND - DTSTART of a VEVENT, or None."""
    start = component.get("dtstart")
    end = component.get("dtend")
    if start is None or end is None:
        return None
    try:
        return end.dt - start.dt
    except TypeError:
        return None


def _truncate_series(
    cal: Calendar, master: Event, uid: str, rec_dt: date | datetime
) -> None:
    """End a recurring series just before the occurrence at `rec_dt`.

    Sets UNTIL on the master RRULE and drops the exceptions that are now
    beyond the end.  When `rec_dt` is the first occurrence nothing would be
    left — UNTIL would precede DTSTART, yet DTSTART itself would still be
    returned as an occurrence — so the whole series is removed instead.
    """
    if isinstance(rec_dt, datetime):
        until: date | datetime = rec_dt - timedelta(seconds=1)
        if until.tzinfo is not None:
            # RFC 5545: UNTIL is in UTC when DTSTART has a timezone.
            until = until.astimezone(timezone.utc)
    else:
        until = rec_dt - timedelta(days=1)

    dtstart = master.get("dtstart")
    if dtstart is not None and _is_before(until, dtstart.dt):
        _LOGGER.debug(
            "local_agenda: truncating uid=%s at its first occurrence — "
            "removing the whole series", uid,
        )
        _remove_uid(cal, uid)
        return

    rrule = master.get("rrule")
    rrule["UNTIL"] = [until]
    rrule.pop("COUNT", None)
    _LOGGER.debug("local_agenda: uid=%s — series UNTIL set to %s", uid, until)
    _remove_overrides(cal, uid, lambda rid: not _is_before(rid, rec_dt))


def _update_whole_series(
    cal: Calendar,
    master: Event,
    uid: str,
    event: dict[str, Any],
    new_start: date | datetime | None,
    new_end: date | datetime | None,
    new_rrule: vRecur | None,
) -> None:
    """Apply an edit to a whole series (or to a non-recurring event)."""
    # Text fields go to the master AND to every RECURRENCE-ID exception:
    # an exception overrides the master's fields for its own occurrence, so
    # occurrences edited individually in the past would otherwise keep their
    # old summary/description/location after an "apply to all".
    for component in cal.walk("VEVENT"):
        if str(component.get("uid", "")) == uid:
            _apply_text_fields(component, event)

    old_start = master.get("dtstart")
    start_moved = (
        new_start is not None
        and (old_start is None or not _same_moment(old_start.dt, new_start))
    )
    _set_times(master, new_start, new_end)

    # RRULE — preserve unless explicitly changed
    if new_rrule is not None:
        if _rrule_to_str(new_rrule) != _rrule_to_str(master.get("rrule")):
            master.pop("rrule", None)
            master.add("rrule", new_rrule)
    elif "rrule" in event:
        # Explicit empty → user intentionally removed recurrence
        master.pop("rrule", None)
    # else: absent → keep existing RRULE untouched

    if start_moved:
        # Shifting DTSTART moves every occurrence: the RECURRENCE-ID
        # exceptions and the EXDATEs now point at times that no longer exist
        # in the series.  recurring_ical_events would surface the exceptions
        # as orphaned standalone events (duplicates), so both are purged.
        # HA sends the start on every edit: this must only happen when the
        # start really changed, or editing a title would bring back every
        # deleted occurrence.
        _remove_overrides(cal, uid, lambda rid: True)
        for key in [k for k in master.keys() if k.upper() == "EXDATE"]:
            master.pop(key, None)


def _update_single_occurrence(
    cal: Calendar,
    master: Event,
    uid: str,
    event: dict[str, Any],
    rec_dt: date | datetime,
    new_start: date | datetime | None,
    new_end: date | datetime | None,
) -> None:
    """Apply an edit to one occurrence of a recurring series.

    RFC 5545 requires a RECURRENCE-ID override VEVENT for this: the master
    VEVENT is left alone, whether the edit changes the time or only a text
    field — writing to the master would change the whole series.
    """
    target: Event | None = None
    for component in cal.walk("VEVENT"):
        if str(component.get("uid", "")) != uid:
            continue
        rid = component.get("RECURRENCE-ID")
        if rid is not None and _same_moment(rid.dt, rec_dt):
            target = component
            break

    if target is None:
        target = Event()
        target.add("uid", uid)
        target.add("dtstamp", dt_util.utcnow())
        target.add("recurrence-id", rec_dt)
        # Seed non-time fields from master so nothing is lost
        for field in _TEXT_FIELDS:
            value = master.get(field)
            if value is not None:
                target.add(field, value)
        cal.add_component(target)

    _set_times(target, new_start, new_end)
    if target.get("dtstart") is None:
        # Text-only edit: the occurrence keeps its original time.
        target.add("dtstart", rec_dt)
    if target.get("dtend") is None:
        duration = _duration(master)
        if duration is not None:
            target.add("dtend", target.get("dtstart").dt + duration)

    _apply_text_fields(target, event)


def _update_this_and_future(
    cal: Calendar,
    master: Event,
    uid: str,
    event: dict[str, Any],
    rec_dt: date | datetime,
    new_start: date | datetime | None,
    new_end: date | datetime | None,
    new_rrule: vRecur | None,
) -> None:
    """Apply an edit to one occurrence and all the following ones.

    RFC 5545 §3.8.4.4 RANGE=THISANDFUTURE: the original series is truncated
    just before `rec_dt` and a new series starts there.
    """
    # Read what the new series inherits BEFORE truncating: the truncation
    # rewrites the master's RRULE (UNTIL), which must not be inherited.
    original_rrule = _rrule_to_str(master.get("rrule"))
    duration = _duration(master)

    _truncate_series(cal, master, uid, rec_dt)

    new_series = Event()
    new_uid = str(uuid.uuid4())
    new_series.add("uid", new_uid)
    new_series.add("dtstamp", dt_util.utcnow())

    series_start = new_start if new_start is not None else rec_dt
    new_series.add("dtstart", series_start)
    if new_end is not None:
        new_series.add("dtend", new_end)
    elif duration is not None:
        new_series.add("dtend", series_start + duration)

    if new_rrule is not None:
        new_series.add("rrule", new_rrule)
    elif "rrule" not in event and original_rrule is not None:
        # HA sent no rule at all: the new series repeats like the old one.
        # (An explicit empty rule means the recurrence was removed.)
        new_series.add("rrule", vRecur.from_ical(original_rrule))

    # Text fields: prefer event dict, fall back to master
    for field in _TEXT_FIELDS:
        value = event.get(field)
        if value is not None:
            if value:
                new_series.add(field, value)
        else:
            master_value = master.get(field)
            if master_value is not None:
                new_series.add(field, master_value)

    cal.add_component(new_series)
    _LOGGER.debug(
        "local_agenda: THISANDFUTURE update — new series uid=%s dtstart=%s",
        new_uid, series_start,
    )


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _safe_calendar(cal: Calendar) -> Calendar:
    """Return a Calendar containing only VEVENTs that have a DTSTART.

    recurring_ical_events raises KeyError('DTSTART') on any VEVENT that
    lacks this property (corrupted events, imports from other apps, etc.).
    Pre-filtering here prevents the error entirely.
    Non-VEVENT components (VTIMEZONE, etc.) are always kept so that
    timezone definitions remain available for date expansion.
    """
    clean = Calendar()
    # Copy calendar-level properties (VERSION, PRODID, X-* …)
    for key in cal:
        clean[key] = cal[key]
    for sub in cal.subcomponents:
        if sub.name == "VEVENT":
            if sub.get("DTSTART") is None:
                _LOGGER.debug(
                    "local_agenda: skipping VEVENT without DTSTART (uid=%s summary=%s)",
                    sub.get("UID", "?"),
                    sub.get("SUMMARY", "?"),
                )
                continue
        clean.subcomponents.append(sub)
    return clean


def _component_to_event(
    component: Any,
    rrule_override: str | None = None,
) -> CalendarEvent | None:
    """Convert an icalendar VEVENT component to a CalendarEvent.

    rrule_override — pass the RRULE string extracted from the *master* VEVENT.
    recurring_ical_events does not include RRULE on the occurrence objects it
    returns, so without this the CalendarEvent would have rrule=None and the
    HA edit dialog would display "Jamais" for every recurring event.
    """
    try:
        dtstart = component.get("dtstart")
        dtend = component.get("dtend")
        if dtstart is None:
            return None
        start = dtstart.dt
        end = dtend.dt if dtend else start

        # RRULE: prefer the value passed from the master VEVENT, fall back
        # to the component's own.
        rrule_str = rrule_override or _rrule_to_str(component.get("rrule"))

        # RECURRENCE-ID: set by recurring_ical_events on each expanded
        # occurrence; lets HA identify which instance is being edited/deleted.
        recurrence_id_str: str | None = None
        rec_id_prop = component.get("RECURRENCE-ID")
        if rec_id_prop is not None:
            try:
                recurrence_id_str = rec_id_prop.to_ical().decode("utf-8")
            except Exception:
                pass

        return CalendarEvent(
            summary=str(component.get("summary", "")),
            start=start,
            end=end,
            description=str(component.get("description", "")) or None,
            location=str(component.get("location", "")) or None,
            uid=str(component.get("uid", "")),
            rrule=rrule_str,
            recurrence_id=recurrence_id_str,
        )
    except Exception as err:
        _LOGGER.debug("Skipping malformed VEVENT: %s", err)
        return None


def _as_utc(dt: date | datetime) -> datetime:
    """Coerce a date or datetime to a tz-aware UTC datetime."""
    if isinstance(dt, datetime):
        return dt_util.as_utc(dt) if dt.tzinfo else dt_util.as_utc(
            dt.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
        )
    # All-day event: treat as midnight local time
    return dt_util.start_of_local_day(dt)
