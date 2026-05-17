"""Calendar platform for local_agenda."""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Any

import recurring_ical_events
from icalendar import Calendar, Event, vText
from homeassistant.components.calendar import (
    CalendarEntity,
    CalendarEntityFeature,
    CalendarEvent,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
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
        """Recompute the next upcoming event in the executor (non-blocking)."""
        now = dt_util.utcnow()
        events = await self._hass.async_add_executor_job(
            self._expand_events, now, now + timedelta(days=365)
        )
        self._next_event = events[0] if events else None

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
        """Expand all events in range, grouping VEVENTs by UID.

        Grouping master + RECURRENCE-ID exception VEVENTs together lets
        recurring_ical_events apply overrides correctly (RFC 5545 §3.8.4.4).
        Processing each UID group independently ensures a single malformed
        event never blocks the others from appearing.
        """
        from collections import defaultdict

        cal = _safe_calendar(self._store.get_calendar_for_read())

        # Collect non-VEVENT components once (VTIMEZONE, etc.) — shared base
        base_subcomponents = [
            c for c in cal.subcomponents if c.name != "VEVENT"
        ]

        # Group VEVENTs by UID so that RECURRENCE-ID exceptions are always
        # processed alongside their master event.
        events_by_uid: dict[str, list] = defaultdict(list)
        for vevent in cal.subcomponents:
            if vevent.name == "VEVENT":
                uid = str(vevent.get("UID", vevent.get("uid", "_no_uid_")))
                events_by_uid[uid].append(vevent)

        events: list[CalendarEvent] = []

        for uid, vevents in events_by_uid.items():
            # Extract RRULE from the master VEVENT (no RECURRENCE-ID).
            # recurring_ical_events v2.x does NOT copy RRULE onto occurrence
            # objects it returns, so we carry it forward so that
            # CalendarEvent.rrule is set and the HA dialog shows the real rule.
            master_vevent = next(
                (v for v in vevents if v.get("RECURRENCE-ID") is None), None
            )
            master_rrule_str: str | None = None
            if master_vevent is not None:
                rrule_prop = master_vevent.get("RRULE")
                if rrule_prop is not None:
                    try:
                        master_rrule_str = rrule_prop.to_ical().decode("utf-8")
                    except Exception:
                        pass

            # Build a mini calendar with ALL VEVENTs for this UID group.
            # This is required for recurring_ical_events to apply
            # RECURRENCE-ID overrides instead of returning them as standalone
            # events.
            mini = Calendar()
            for key in cal:
                mini[key] = cal[key]
            mini.subcomponents = base_subcomponents + vevents

            try:
                occ_list = recurring_ical_events.of(
                    mini, components=["VEVENT"]
                ).between(start_date, end_date)
                for occ in occ_list:
                    evt = _component_to_event(occ, rrule_override=master_rrule_str)
                    if evt is not None:
                        events.append(evt)
            except Exception as err:
                _LOGGER.warning(
                    "local_agenda: skipping uid=%s (%s): %s",
                    uid,
                    master_vevent.get("SUMMARY", "?") if master_vevent else "?",
                    err,
                )

        events.sort(key=lambda e: _as_utc(e.start))
        return events

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def async_create_event(self, **kwargs: Any) -> None:
        """Create a new event (called by HA frontend)."""
        from icalendar import vRecur
        _LOGGER.debug("local_agenda: create_event kwargs keys=%s", list(kwargs.keys()))
        # Normalise start/end — HA may use dtstart OR start_date_time/start_date
        start = (kwargs.get("dtstart") or kwargs.get("start_date_time")
                 or kwargs.get("start_date"))
        end   = (kwargs.get("dtend")   or kwargs.get("end_date_time")
                 or kwargs.get("end_date") or start)
        cal = self._store.get_calendar()
        component = Event()
        component.add("uid", str(uuid.uuid4()))
        component.add("summary", kwargs.get("summary", ""))
        component.add("dtstart", start)
        component.add("dtend", end)
        if desc := kwargs.get("description"):
            component.add("description", desc)
        if loc := kwargs.get("location"):
            component.add("location", loc)
        if rrule := kwargs.get("rrule"):
            _LOGGER.debug("local_agenda: create_event rrule=%s", rrule)
            try:
                component.add("rrule", vRecur.from_ical(rrule))
            except Exception as err:
                _LOGGER.warning("local_agenda: could not parse rrule '%s': %s", rrule, err)
        cal.add_component(component)
        await self._store.async_save(self._hass)
        await self._refresh_next_event()
        self.async_write_ha_state()

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
        from icalendar import vDatetime, vDate
        import datetime as _dt

        _LOGGER.debug(
            "local_agenda: delete_event uid=%s recurrence_id=%s range=%s",
            uid, recurrence_id, recurrence_range,
        )
        cal = self._store.get_calendar()

        if recurrence_id is None:
            # Delete the whole VEVENT series (master + all RECURRENCE-ID exceptions)
            before = len(cal.subcomponents)
            cal.subcomponents = [
                c for c in cal.subcomponents
                if not (c.name == "VEVENT" and str(c.get("uid", "")) == uid)
            ]
            _LOGGER.debug(
                "local_agenda: delete_event ALL — removed %d component(s)",
                before - len(cal.subcomponents),
            )
        else:
            # Parse recurrence_id to a date/datetime
            rec_dt = None
            try:
                rec_dt = vDatetime.from_ical(recurrence_id)
            except Exception:
                try:
                    rec_dt = vDate.from_ical(recurrence_id)
                except Exception:
                    pass

            _LOGGER.debug(
                "local_agenda: delete_event parsed rec_dt=%s", rec_dt
            )

            # Always operate on the MASTER VEVENT (no RECURRENCE-ID property).
            # Exceptions (RECURRENCE-ID VEVENTs) share the same uid but must not
            # be confused with the master when modifying RRULE or EXDATE.
            master_component = None
            for component in cal.walk("VEVENT"):
                if (str(component.get("uid", "")) == uid
                        and component.get("RECURRENCE-ID") is None):
                    master_component = component
                    break

            if master_component is not None:
                if recurrence_range == "THISANDFUTURE" and rec_dt is not None:
                    # Truncate: set UNTIL to the moment before this occurrence.
                    # Edge case: if rec_dt <= DTSTART the RRULE would still let
                    # recurring_ical_events return DTSTART as a standalone
                    # occurrence.  In that case we must delete the whole series.
                    rrule = master_component.get("rrule")
                    if rrule:
                        if isinstance(rec_dt, _dt.datetime):
                            until = rec_dt - _dt.timedelta(seconds=1)
                        else:
                            until = rec_dt - _dt.timedelta(days=1)

                        dtstart_prop = master_component.get("dtstart")
                        dtstart_dt = dtstart_prop.dt if dtstart_prop is not None else None

                        # Normalise types for comparison: date → datetime
                        if (dtstart_dt is not None
                                and isinstance(until, _dt.datetime)
                                and isinstance(dtstart_dt, _dt.date)
                                and not isinstance(dtstart_dt, _dt.datetime)):
                            dtstart_dt = _dt.datetime(
                                dtstart_dt.year, dtstart_dt.month, dtstart_dt.day
                            )

                        # Normalise timezone awareness: strip tz from the aware
                        # side if one datetime is naive and the other is aware.
                        # (HA 2026.4 sends recurrence_id without timezone info
                        #  while DTSTART in the .ics may carry TZID.)
                        if (dtstart_dt is not None
                                and isinstance(until, _dt.datetime)
                                and isinstance(dtstart_dt, _dt.datetime)):
                            if until.tzinfo is None and dtstart_dt.tzinfo is not None:
                                dtstart_dt = dtstart_dt.replace(tzinfo=None)
                            elif until.tzinfo is not None and dtstart_dt.tzinfo is None:
                                until = until.replace(tzinfo=None)

                        if dtstart_dt is not None and until < dtstart_dt:
                            # UNTIL would be before DTSTART → delete whole series.
                            _LOGGER.debug(
                                "local_agenda: delete_event THISANDFUTURE — "
                                "until=%s < dtstart=%s, deleting whole series",
                                until, dtstart_dt,
                            )
                            cal.subcomponents = [
                                c for c in cal.subcomponents
                                if not (c.name == "VEVENT"
                                        and str(c.get("uid", "")) == uid)
                            ]
                        else:
                            rrule["UNTIL"] = [until]
                            rrule.pop("COUNT", None)
                            _LOGGER.debug(
                                "local_agenda: delete_event THISANDFUTURE — "
                                "set UNTIL=%s", until,
                            )
                else:
                    # Exclude just this occurrence via EXDATE on the master.
                    # We always add a new EXDATE property rather than trying to
                    # merge into an existing one — multiple EXDATE entries are
                    # perfectly valid per RFC 5545, and this avoids the
                    # icalendar 5.x vDDDLists type error that occurs when
                    # the component.add() helper receives a non-datetime value.
                    if rec_dt is not None:
                        master_component.add("exdate", rec_dt)
                        _LOGGER.debug(
                            "local_agenda: delete_event THIS — added EXDATE %s", rec_dt
                        )

            # For single-occurrence deletes: also remove any RECURRENCE-ID
            # override VEVENT that matches this date (the "doublon" case).
            # Without this step the exception VEVENT persists in the file and
            # keeps appearing in the calendar even after the EXDATE is set.
            if recurrence_range != "THISANDFUTURE" and rec_dt is not None:
                def _is_matching_override(c: Any) -> bool:
                    if c.name != "VEVENT" or str(c.get("uid", "")) != uid:
                        return False
                    rid = c.get("RECURRENCE-ID")
                    if rid is None:
                        return False
                    try:
                        return rid.dt == rec_dt
                    except Exception:
                        return False

                before_exc = len(cal.subcomponents)
                cal.subcomponents = [
                    c for c in cal.subcomponents if not _is_matching_override(c)
                ]
                _LOGGER.debug(
                    "local_agenda: delete_event THIS — removed %d RECURRENCE-ID override(s)",
                    before_exc - len(cal.subcomponents),
                )

        await self._store.async_save(self._hass)
        await self._refresh_next_event()
        self.async_write_ha_state()

    async def async_update_event(
        self,
        uid: str,
        event: dict[str, Any],
        recurrence_id: str | None = None,
        recurrence_range: str | None = None,
    ) -> None:
        """Update an event or one occurrence of a recurring series."""
        from icalendar import vRecur, vDatetime, vDate
        import datetime as _dt

        _LOGGER.debug(
            "local_agenda: update_event uid=%s recurrence_id=%s range=%s event_keys=%s",
            uid, recurrence_id, recurrence_range, list(event.keys()),
        )

        editing_whole_series = recurrence_id is None
        # THISANDFUTURE: recurrence_id is set but the edit applies to this
        # occurrence AND all subsequent ones — must be handled separately.
        editing_this_and_future = (
            recurrence_range == "THISANDFUTURE" and not editing_whole_series
        )

        # Normalise start/end — HA may send dtstart or start_date_time/start_date
        new_start = (event.get("dtstart") or event.get("start_date_time")
                     or event.get("start_date"))
        new_end   = (event.get("dtend")   or event.get("end_date_time")
                     or event.get("end_date"))

        _LOGGER.debug(
            "local_agenda: update_event editing_whole_series=%s new_start=%s new_end=%s rrule=%s",
            editing_whole_series, new_start, new_end, event.get("rrule"),
        )

        cal = self._store.get_calendar()

        # ------------------------------------------------------------------ #
        # THISANDFUTURE: truncate original series + create a new one          #
        # RFC 5545 §3.8.4.4 RANGE=THISANDFUTURE                              #
        # ------------------------------------------------------------------ #
        if editing_this_and_future:
            rec_dt = None
            try:
                rec_dt = vDatetime.from_ical(recurrence_id)
            except Exception:
                try:
                    rec_dt = vDate.from_ical(recurrence_id)
                except Exception:
                    pass

            _LOGGER.debug(
                "local_agenda: THISANDFUTURE update — rec_dt=%s", rec_dt
            )

            # Find the master VEVENT (no RECURRENCE-ID property)
            master_taf: Event | None = None
            for _c in cal.walk("VEVENT"):
                if (str(_c.get("uid", "")) == uid
                        and _c.get("RECURRENCE-ID") is None):
                    master_taf = _c
                    break

            if master_taf is not None and rec_dt is not None and master_taf.get("rrule") is not None:
                # ---- Step 1: Truncate the original series at rec_dt ----
                rrule_taf = master_taf.get("rrule")
                if isinstance(rec_dt, _dt.datetime):
                    until_taf = rec_dt - _dt.timedelta(seconds=1)
                else:
                    until_taf = rec_dt - _dt.timedelta(days=1)

                dtstart_prop_taf = master_taf.get("dtstart")
                dtstart_dt_taf = dtstart_prop_taf.dt if dtstart_prop_taf is not None else None

                # date → datetime coercion for comparison
                if (dtstart_dt_taf is not None
                        and isinstance(until_taf, _dt.datetime)
                        and isinstance(dtstart_dt_taf, _dt.date)
                        and not isinstance(dtstart_dt_taf, _dt.datetime)):
                    dtstart_dt_taf = _dt.datetime(
                        dtstart_dt_taf.year, dtstart_dt_taf.month, dtstart_dt_taf.day
                    )

                # Timezone normalization (HA sends naive recurrence_id)
                if (dtstart_dt_taf is not None
                        and isinstance(until_taf, _dt.datetime)
                        and isinstance(dtstart_dt_taf, _dt.datetime)):
                    if until_taf.tzinfo is None and dtstart_dt_taf.tzinfo is not None:
                        dtstart_dt_taf = dtstart_dt_taf.replace(tzinfo=None)
                    elif until_taf.tzinfo is not None and dtstart_dt_taf.tzinfo is None:
                        until_taf = until_taf.replace(tzinfo=None)

                if dtstart_dt_taf is not None and until_taf < dtstart_dt_taf:
                    # Editing from the first occurrence → remove whole original series
                    _LOGGER.debug(
                        "local_agenda: THISANDFUTURE update — "
                        "until=%s < dtstart=%s, removing whole original series",
                        until_taf, dtstart_dt_taf,
                    )
                    cal.subcomponents = [
                        c for c in cal.subcomponents
                        if not (c.name == "VEVENT" and str(c.get("uid", "")) == uid)
                    ]
                else:
                    rrule_taf["UNTIL"] = [until_taf]
                    rrule_taf.pop("COUNT", None)
                    _LOGGER.debug(
                        "local_agenda: THISANDFUTURE update — "
                        "original series UNTIL set to %s", until_taf,
                    )
                    # Remove RECURRENCE-ID exceptions that fall on or after rec_dt
                    # (they are now beyond the truncation point)
                    _rec_dt_for_cmp = rec_dt

                    def _exc_on_or_after(c: Any) -> bool:
                        rid_prop = c.get("RECURRENCE-ID")
                        if c.name != "VEVENT" or str(c.get("uid", "")) != uid:
                            return False
                        if rid_prop is None:
                            return False
                        try:
                            rid_dt = rid_prop.dt
                            cmp = _rec_dt_for_cmp
                            if isinstance(rid_dt, _dt.datetime) and isinstance(cmp, _dt.datetime):
                                if rid_dt.tzinfo is None and cmp.tzinfo is not None:
                                    cmp = cmp.replace(tzinfo=None)
                                elif rid_dt.tzinfo is not None and cmp.tzinfo is None:
                                    rid_dt = rid_dt.replace(tzinfo=None)
                            return rid_dt >= cmp
                        except Exception:
                            return False

                    before_exc = len(cal.subcomponents)
                    cal.subcomponents = [
                        c for c in cal.subcomponents if not _exc_on_or_after(c)
                    ]
                    _LOGGER.debug(
                        "local_agenda: THISANDFUTURE update — removed %d future exception(s)",
                        before_exc - len(cal.subcomponents),
                    )

                # ---- Step 2: Create the new event series from rec_dt ----
                new_series = Event()
                new_uid = str(uuid.uuid4())
                new_series.add("uid", new_uid)

                series_start = new_start if new_start is not None else rec_dt
                new_series.add("dtstart", series_start)

                if new_end is not None:
                    new_series.add("dtend", new_end)
                elif new_start is not None:
                    m_start_p = master_taf.get("dtstart")
                    m_end_p   = master_taf.get("dtend")
                    if m_start_p is not None and m_end_p is not None:
                        try:
                            new_series.add("dtend", series_start + (m_end_p.dt - m_start_p.dt))
                        except Exception:
                            pass

                # RRULE: HA sends the (possibly updated) rule in the event dict
                incoming_rrule_taf: str | None = event.get("rrule")
                if incoming_rrule_taf:
                    try:
                        new_series.add("rrule", vRecur.from_ical(incoming_rrule_taf))
                    except Exception as err:
                        _LOGGER.warning(
                            "local_agenda: THISANDFUTURE rrule parse error '%s': %s",
                            incoming_rrule_taf, err,
                        )
                else:
                    # Carry master RRULE (UNTIL/COUNT already stripped above)
                    master_rrule_taf = master_taf.get("rrule")
                    if master_rrule_taf is not None:
                        try:
                            new_series.add(
                                "rrule",
                                vRecur.from_ical(master_rrule_taf.to_ical().decode("utf-8")),
                            )
                        except Exception:
                            pass

                # Text fields: prefer event dict, fall back to master
                for _field in ("summary", "description", "location"):
                    _val = event.get(_field)
                    if _val is not None:
                        if _val:
                            new_series.add(_field, _val)
                    else:
                        _mval = master_taf.get(_field)
                        if _mval is not None:
                            new_series.add(_field, _mval)

                cal.add_component(new_series)
                _LOGGER.debug(
                    "local_agenda: THISANDFUTURE update — "
                    "new series uid=%s dtstart=%s",
                    new_uid, series_start,
                )

            else:
                # No RRULE or missing master/rec_dt — update the event in-place
                _LOGGER.debug(
                    "local_agenda: THISANDFUTURE update — no RRULE/master, "
                    "falling through to in-place edit",
                )
                for _c in cal.walk("VEVENT"):
                    if str(_c.get("uid", "")) != uid:
                        continue
                    if "summary" in event:
                        del _c["summary"]
                        _c.add("summary", event["summary"])
                    if "description" in event:
                        _c.pop("description", None)
                        if event["description"]:
                            _c.add("description", event["description"])
                    if "location" in event:
                        _c.pop("location", None)
                        if event["location"]:
                            _c.add("location", event["location"])
                    if new_start is not None:
                        _c.pop("dtstart", None)
                        _c.add("dtstart", new_start)
                    if new_end is not None:
                        _c.pop("dtend", None)
                        _c.add("dtend", new_end)
                    break

        # ------------------------------------------------------------------ #
        # Single-occurrence edit WITH time change                              #
        # RFC 5545 requires a RECURRENCE-ID override VEVENT for this case.    #
        # We must NOT modify the master VEVENT's DTSTART/DTEND — that would   #
        # shift or destroy the whole series.                                   #
        # ------------------------------------------------------------------ #
        elif not editing_whole_series and (new_start is not None or new_end is not None):
            # Parse recurrence_id back to a date/datetime
            rec_dt = None
            try:
                rec_dt = vDatetime.from_ical(recurrence_id)
            except Exception:
                try:
                    rec_dt = vDate.from_ical(recurrence_id)
                except Exception:
                    pass

            _LOGGER.debug(
                "local_agenda: single-occurrence time change — rec_dt=%s", rec_dt
            )

            # Find the master VEVENT (no RECURRENCE-ID property)
            master: Event | None = None
            for component in cal.walk("VEVENT"):
                if (str(component.get("uid", "")) == uid
                        and component.get("RECURRENCE-ID") is None):
                    master = component
                    break

            # Look for an existing RECURRENCE-ID exception for this occurrence
            existing_exception: Event | None = None
            if rec_dt is not None:
                for component in cal.walk("VEVENT"):
                    if str(component.get("uid", "")) != uid:
                        continue
                    exc_rec_id = component.get("RECURRENCE-ID")
                    if exc_rec_id is not None:
                        try:
                            if exc_rec_id.dt == rec_dt:
                                existing_exception = component
                                break
                        except Exception:
                            pass

            if existing_exception is not None:
                # Update the existing exception in place
                target: Event = existing_exception
            else:
                # Create a new RECURRENCE-ID override VEVENT
                target = Event()
                target.add("uid", uid)
                if rec_dt is not None:
                    target.add("recurrence-id", rec_dt)
                # Seed non-time fields from master so nothing is lost
                if master is not None:
                    for field in ("summary", "description", "location"):
                        val = master.get(field)
                        if val is not None:
                            target.add(field, val)
                cal.add_component(target)

            # Apply time changes to the exception
            if new_start is not None:
                target.pop("dtstart", None)
                target.add("dtstart", new_start)
            if new_end is not None:
                target.pop("dtend", None)
                target.add("dtend", new_end)
            elif target.get("dtend") is None and master is not None:
                # New exception with no explicit end: inherit master duration
                m_start = master.get("dtstart")
                m_end   = master.get("dtend")
                if m_start is not None and m_end is not None and new_start is not None:
                    duration = m_end.dt - m_start.dt
                    target.add("dtend", new_start + duration)
                elif m_end is not None:
                    target.add("dtend", m_end.dt)

            # Apply non-time field changes to the exception
            if "summary" in event:
                target.pop("summary", None)
                target.add("summary", event["summary"])
            if "description" in event:
                target.pop("description", None)
                if event["description"]:
                    target.add("description", event["description"])
            if "location" in event:
                target.pop("location", None)
                if event["location"]:
                    target.add("location", event["location"])

        else:
            # ---------------------------------------------------------------- #
            # Whole-series edit  OR  single-occurrence non-time field update   #
            # ---------------------------------------------------------------- #
            for component in cal.walk("VEVENT"):
                if str(component.get("uid", "")) != uid:
                    continue

                is_master = component.get("RECURRENCE-ID") is None

                # ---- Text fields ----
                # For whole-series edits we update the master AND every
                # RECURRENCE-ID exception VEVENT, because exceptions override
                # the master's fields for their specific occurrence.  Without
                # this, occurrences that were individually edited in the past
                # would keep showing their old description/summary/location
                # even after the user chose "apply to all".
                if "summary" in event:
                    del component["summary"]
                    component.add("summary", event["summary"])
                if "description" in event:
                    component.pop("description", None)
                    if event["description"]:
                        component.add("description", event["description"])
                if "location" in event:
                    component.pop("location", None)
                    if event["location"]:
                        component.add("location", event["location"])

                # ---- Time + recurrence: whole-series, master VEVENT only ----
                if editing_whole_series and is_master:
                    if new_start is not None:
                        component.pop("dtstart", None)
                        component.add("dtstart", new_start)
                    if new_end is not None:
                        component.pop("dtend", None)
                        component.add("dtend", new_end)

                    # RRULE — preserve unless explicitly changed
                    existing_rrule = component.get("rrule")
                    existing_rrule_str: str | None = None
                    if existing_rrule is not None:
                        try:
                            existing_rrule_str = existing_rrule.to_ical().decode("utf-8")
                        except Exception:
                            pass

                    incoming_rrule: str | None = event.get("rrule")
                    _LOGGER.debug(
                        "local_agenda: existing_rrule=%s incoming_rrule=%s",
                        existing_rrule_str, incoming_rrule,
                    )
                    if incoming_rrule and incoming_rrule != existing_rrule_str:
                        component.pop("rrule", None)
                        try:
                            component.add("rrule", vRecur.from_ical(incoming_rrule))
                        except Exception as err:
                            _LOGGER.warning(
                                "local_agenda: could not parse rrule '%s': %s",
                                incoming_rrule, err,
                            )
                    elif "rrule" in event and not incoming_rrule and existing_rrule is not None:
                        # Explicit empty → user intentionally removed recurrence
                        component.pop("rrule", None)
                    # else: absent or same → keep existing RRULE untouched

                # For single-occurrence non-time edits: stop after the first
                # VEVENT (the master) — we only want to touch that one component.
                # For whole-series edits: keep iterating to reach all exceptions.
                if not editing_whole_series:
                    break

        # When a whole-series time edit shifts DTSTART, all existing
        # RECURRENCE-ID exception VEVENTs become stale: their RECURRENCE-ID
        # references an occurrence time that no longer exists in the updated
        # RRULE series.  recurring_ical_events then surfaces them as orphaned
        # standalone events — the "doublon" reported by the user.
        # Solution: purge every RECURRENCE-ID exception for that UID so the
        # series is clean.
        if editing_whole_series and new_start is not None:
            before_count = len(cal.subcomponents)
            cal.subcomponents = [
                c for c in cal.subcomponents
                if not (
                    c.name == "VEVENT"
                    and str(c.get("uid", "")) == uid
                    and c.get("RECURRENCE-ID") is not None
                )
            ]
            removed = before_count - len(cal.subcomponents)
            if removed:
                _LOGGER.debug(
                    "local_agenda: whole-series time edit — removed %d stale "
                    "RECURRENCE-ID exception(s) for uid=%s",
                    removed, uid,
                )

        await self._store.async_save(self._hass)
        await self._refresh_next_event()
        self.async_write_ha_state()


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
    recurring_ical_events v2.x does not include RRULE on the occurrence
    objects it returns, so without this the CalendarEvent would have rrule=None
    and the HA edit dialog would display "Jamais" for every recurring event.
    """
    try:
        dtstart = component.get("dtstart")
        dtend = component.get("dtend")
        if dtstart is None:
            return None
        start = dtstart.dt
        end = dtend.dt if dtend else start

        # RRULE: prefer the value passed from the master VEVENT.
        # Fall back to reading it from the component (handles non-recurring
        # events and any future library version that does copy RRULE).
        rrule_str: str | None = rrule_override
        if rrule_str is None:
            rrule_prop = component.get("rrule")
            if rrule_prop is not None:
                try:
                    rrule_str = rrule_prop.to_ical().decode("utf-8")
                except Exception:
                    pass

        # RECURRENCE-ID: set by recurring_ical_events on each expanded
        # occurrence; lets HA identify which instance is being edited/deleted.
        recurrence_id_str: str | None = None
        rec_id_prop = component.get("RECURRENCE-ID")
        if rec_id_prop is not None:
            try:
                recurrence_id_str = rec_id_prop.to_ical().decode("utf-8")
            except Exception:
                pass

        # CalendarEvent gained `rrule` in HA 2024.x and `recurrence_id`
        # later — fall back gracefully for older installs.
        try:
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
        except TypeError:
            try:
                return CalendarEvent(
                    summary=str(component.get("summary", "")),
                    start=start,
                    end=end,
                    description=str(component.get("description", "")) or None,
                    location=str(component.get("location", "")) or None,
                    uid=str(component.get("uid", "")),
                    rrule=rrule_str,
                )
            except TypeError:
                return CalendarEvent(
                    summary=str(component.get("summary", "")),
                    start=start,
                    end=end,
                    description=str(component.get("description", "")) or None,
                    location=str(component.get("location", "")) or None,
                    uid=str(component.get("uid", "")),
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
