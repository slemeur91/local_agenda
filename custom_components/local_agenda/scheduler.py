"""Scheduler: runs on_start / on_stop when events start and end.

The scheduler keeps the moment up to which it has processed the calendar
(`last`).  Each pass handles every start and end in (last, now], then moves
`last` to now, so a transition is handled exactly once whatever the delay
between two passes — no time window, no deduplication set.

Passes run every 20 seconds, on a timer set at the next transition (so
actions run on time, not up to one tick late), and right after any change to
the calendar.  `last` is saved to disk, which lets the scheduler catch up on
what happened while Home Assistant was stopped:

- a start missed while stopped runs if its event is still in progress;
- an end missed while stopped runs if its event had started before;
- an event that started and ended while stopped is skipped entirely.

The scheduler also remembers the events whose start it handled and which
have an on_stop.  If such an event disappears before its end (deleted, moved
or shortened to an end already past), its on_stop runs immediately: a
heating turned on by an event is turned off when that event is removed.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import logging
from collections import deque
from datetime import datetime, timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.helpers.event import (
    async_track_point_in_utc_time,
    async_track_time_interval,
)
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .actions import fire_actions, parse_actions
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

TICK = timedelta(seconds=20)
# Transitions further back than this are being caught up, not on time.
LATE = timedelta(minutes=5)
# Nothing older than this is caught up after a long stop.
MAX_CATCH_UP = timedelta(days=7)
# Each pass also looks this far ahead, to set a timer on the next transition.
LOOKAHEAD = timedelta(minutes=1)

STORAGE_VERSION = 1
# Executions kept for the panel's "Exécutions" view.
HISTORY_SIZE = 100


class _CalendarUnreadable(Exception):
    """The events could not be read: the interval must be processed again."""


def comparable(value: Any) -> datetime:
    """Return a tz-aware datetime for a CalendarEvent start/end value.

    All-day values (dates) start at local midnight; a floating datetime (no
    timezone, possible in an imported .ics) is read as local time.
    """
    if not isinstance(value, _dt.datetime):
        return dt_util.start_of_local_day(value)
    if value.tzinfo is None:
        return value.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
    return value


def _event_variables(evt: Any, start: datetime, end: datetime) -> dict[str, Any]:
    """The `event` variable given to the actions."""
    return {
        "uid": getattr(evt, "uid", None) or "",
        "summary": evt.summary or "",
        "description": getattr(evt, "description", None) or "",
        "location": getattr(evt, "location", None) or "",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "all_day": not isinstance(evt.start, _dt.datetime),
    }


class AgendaScheduler:
    """Run the actions of one calendar (config entry)."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self._hass = hass
        self._entry = entry
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, f"{DOMAIN}.scheduler.{entry.entry_id}"
        )
        self._lock = asyncio.Lock()
        self._last: datetime | None = None
        # Started events with an on_stop, by "uid|start": what to run if the
        # event disappears before its end.
        self._running: dict[str, dict[str, Any]] = {}
        self._timer_at: datetime | None = None
        self._unsubs: list[CALLBACK_TYPE] = []
        self._unsub_timer: CALLBACK_TYPE | None = None
        self._stopped = False
        self._history: deque[dict[str, Any]] = deque(maxlen=HISTORY_SIZE)

    # ------------------------------------------------------------------
    # Life cycle
    # ------------------------------------------------------------------

    async def async_start(self) -> None:
        """Load the saved state, then start once Home Assistant runs.

        Waiting for Home Assistant to be started means the actions caught up
        after a restart find the services of every other integration.
        """
        data = await self._store.async_load() or {}
        now = dt_util.utcnow()
        last = dt_util.parse_datetime(data["last"]) if data.get("last") else None
        if last is None or last > now + timedelta(days=1):
            last = now  # first run, or a clock that was badly wrong
        self._last = max(last, now - MAX_CATCH_UP)
        self._running = dict(data.get("running") or {})
        self._history.extend(data.get("history") or [])
        self._unsubs.append(async_at_started(self._hass, self._async_started))

    async def _async_started(self, _hass: HomeAssistant) -> None:
        if self._stopped:
            return
        self._unsubs.append(
            async_track_time_interval(self._hass, self._async_tick, TICK)
        )
        self._unsubs.append(
            self._hass.bus.async_listen(f"{DOMAIN}_updated", self._on_calendar_changed)
        )
        await self.async_process()

    async def async_stop(self) -> None:
        self._stopped = True
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        self._cancel_timer()
        if self._last is not None:
            await self._store.async_save(self._data())

    # ------------------------------------------------------------------
    # Triggers
    # ------------------------------------------------------------------

    async def _async_tick(self, _now: datetime) -> None:
        await self.async_process()

    @callback
    def _on_calendar_changed(self, event: Event) -> None:
        if event.data.get("entry_id") == self._entry.entry_id:
            self._hass.async_create_task(self.async_process())

    @callback
    def _on_timer(self, when: datetime) -> None:
        self._unsub_timer = None
        self._timer_at = None
        # Process up to the transition itself even if the timer is a few
        # milliseconds early.
        self._hass.async_create_task(
            self.async_process(max(dt_util.utcnow(), when))
        )

    def _cancel_timer(self) -> None:
        if self._unsub_timer is not None:
            self._unsub_timer()
        self._unsub_timer = None
        self._timer_at = None

    def _set_timer(self, when: datetime | None) -> None:
        if when == self._timer_at:
            return
        self._cancel_timer()
        if when is not None and not self._stopped:
            self._timer_at = when
            self._unsub_timer = async_track_point_in_utc_time(
                self._hass, self._on_timer, when
            )

    # ------------------------------------------------------------------
    # Processing
    # ------------------------------------------------------------------

    async def async_process(self, until: datetime | None = None) -> None:
        """Handle every transition in (last, until]."""
        if self._stopped or self._last is None:
            return
        async with self._lock:
            until = until or dt_util.utcnow()
            since = self._last
            # An empty interval (until == since) still checks the started
            # events: a calendar change must be seen at once, even when it
            # happens at the instant of the previous pass.
            if until < since:
                return
            try:
                changed = await self._async_process(since, until)
            except _CalendarUnreadable as err:
                # Keep `last`: the interval is processed again next time
                # instead of its transitions being lost.
                _LOGGER.warning("local_agenda: could not read the calendar: %s", err)
                return
            self._last = until
            if changed:
                await self._store.async_save(self._data())
            else:
                # Only `last` moved: replaying an interval in which nothing
                # happened is harmless, so this save can wait.
                self._store.async_delay_save(self._data, 60)

    async def _async_process(self, since: datetime, until: datetime) -> bool:
        """Run the transitions of (since, until]; True when something ran."""
        entities = [
            entity
            for entity in self._hass.data.get(DOMAIN, {})
            .get(self._entry.entry_id, {})
            .get("entities", [])
            if entity.enabled
        ]
        if not entities or self.suspended:
            # A disabled or suspended calendar runs nothing and keeps what
            # it tracks; what falls in the meantime is not caught up.
            self._set_timer(None)
            return False

        events: list[Any] = []
        for entity in entities:
            try:
                events.extend(
                    await entity.async_get_events(self._hass, since, until + LOOKAHEAD)
                )
            except Exception as err:
                raise _CalendarUnreadable(err) from err

        transitions: list[tuple[datetime, int, str, Any, dict, datetime, datetime]] = []
        in_progress: set[str] = set()
        next_at: datetime | None = None
        for evt in events:
            try:
                start = comparable(evt.start)
                end = comparable(evt.end)
                uid = getattr(evt, "uid", None) or evt.summary or "?"
                if start <= until < end:
                    in_progress.add(uid)
                actions = parse_actions(getattr(evt, "description", "") or "")
                if not actions:
                    continue
                # Ends before starts at the same moment: what an event turns
                # off must not undo what the next one just turned on.
                for moment, order, phase in ((end, 0, "stop"), (start, 1, "start")):
                    key = "on_stop" if phase == "stop" else "on_start"
                    tracked = phase == "start" and actions.get("on_stop")
                    if not actions.get(key) and not tracked:
                        continue
                    if since < moment <= until:
                        transitions.append((moment, order, phase, evt, actions, start, end))
                    elif until < moment and (next_at is None or moment < next_at):
                        next_at = moment
            except Exception:
                _LOGGER.exception(
                    "local_agenda: cannot read event '%s'", getattr(evt, "summary", "?")
                )

        transitions.sort(key=lambda t: (t[0], t[1]))
        changed = False
        for moment, _order, phase, evt, actions, start, end in transitions:
            try:
                changed |= await self._async_transition(
                    phase, evt, actions, start, end, moment, since, until
                )
            except Exception:
                _LOGGER.exception(
                    "local_agenda: actions failed for event '%s'",
                    getattr(evt, "summary", "?"),
                )

        changed |= await self._async_stop_vanished(in_progress, until)
        self._set_timer(next_at)
        return changed

    async def _async_transition(
        self,
        phase: str,
        evt: Any,
        actions: dict,
        start: datetime,
        end: datetime,
        moment: datetime,
        since: datetime,
        until: datetime,
    ) -> bool:
        uid = getattr(evt, "uid", None) or evt.summary or "?"
        key = f"{uid}|{start.isoformat()}"
        late = moment < until - LATE
        variables = {
            "agenda": self._entry.title,
            "event": _event_variables(evt, start, end),
        }

        if phase == "start":
            if late and end <= until:
                _LOGGER.info(
                    "local_agenda: '%s' started and ended while Home Assistant "
                    "was stopped — skipped", evt.summary,
                )
                self._record(evt.summary, uid, start, "start", "missed", moment)
                return True
            if actions.get("on_stop"):
                self._running[key] = {
                    "uid": uid,
                    "end": end.isoformat(),
                    "on_stop": actions["on_stop"],
                    "variables": variables,
                }
            if actions.get("on_start"):
                if late:
                    _LOGGER.info(
                        "local_agenda: catching up the start of '%s' (%s)",
                        evt.summary, start,
                    )
                status = await fire_actions(
                    self._hass, actions["on_start"], evt.summary, "start", variables
                )
                self._record(
                    evt.summary, uid, start, "start", status, moment,
                    "catch_up" if late else None,
                )
            return True

        self._running.pop(key, None)
        if late and start > since:
            return True  # its start was skipped too: nothing to undo
        if late:
            _LOGGER.info(
                "local_agenda: catching up the end of '%s' (%s)", evt.summary, end
            )
        status = await fire_actions(
            self._hass, actions["on_stop"], evt.summary, "stop", variables
        )
        self._record(
            evt.summary, uid, start, "stop", status, moment, "catch_up" if late else None
        )
        return True

    async def _async_stop_vanished(self, in_progress: set[str], until: datetime) -> bool:
        """Run on_stop for started events that are no longer in progress.

        Their end was not reached normally (it would have removed them): the
        event was deleted, moved, or shortened to an end already past.  The
        on_stop known when the event started is used, since the event itself
        may be gone.
        """
        changed = False
        for key, info in list(self._running.items()):
            if info["uid"] in in_progress:
                continue
            del self._running[key]
            changed = True
            variables = info.get("variables") or {}
            summary = (variables.get("event") or {}).get("summary") or info["uid"]
            _LOGGER.info(
                "local_agenda: '%s' is no longer in progress (deleted, moved or "
                "shortened) — running its on_stop", summary,
            )
            try:
                status = await fire_actions(
                    self._hass, info["on_stop"], summary, "stop", variables
                )
            except Exception:
                _LOGGER.exception("local_agenda: on_stop failed for '%s'", summary)
                status = "error"
            start = dt_util.parse_datetime(key.split("|", 1)[1]) if "|" in key else None
            self._record(summary, info["uid"], start, "stop", status, until, "vanished")
        return changed

    # ------------------------------------------------------------------
    # Panel
    # ------------------------------------------------------------------

    @property
    def suspended(self) -> bool:
        """Suspended from the panel: nothing runs until resumed."""
        return bool(self._entry.options.get("suspended"))

    @property
    def history(self) -> list[dict[str, Any]]:
        """Latest executions, most recent first."""
        return list(reversed(self._history))

    def _record(
        self,
        summary: str,
        uid: str,
        start: datetime | None,
        phase: str,
        status: str,
        moment: datetime,
        reason: str | None = None,
    ) -> None:
        """Remember an execution for the panel and tell open panels."""
        self._history.append({
            "at": dt_util.utcnow().isoformat(),
            "planned": moment.isoformat(),
            "uid": uid,
            "start": start.isoformat() if start else None,
            "summary": summary,
            "phase": phase,
            # ran / conditions / empty / invalid / missed / error
            "status": status,
            # None (on time) / catch_up / vanished
            "reason": reason,
        })
        self._hass.bus.async_fire(
            f"{DOMAIN}_history", {"entry_id": self._entry.entry_id}
        )

    def _data(self) -> dict[str, Any]:
        return {
            "last": self._last.isoformat() if self._last else None,
            "running": self._running,
            "history": list(self._history),
        }
