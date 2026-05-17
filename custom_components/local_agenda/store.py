"""Store calendar data and provide access."""
from __future__ import annotations

import logging
from pathlib import Path

from icalendar import Calendar

_LOGGER = logging.getLogger(__name__)

_EMPTY_ICS = (
    b"BEGIN:VCALENDAR\r\n"
    b"VERSION:2.0\r\n"
    b"PRODID:-//Local Agenda//NONSGML v1.0//EN\r\n"
    b"END:VCALENDAR\r\n"
)


class LocalAgendaStore:
    """Handle storage of local agenda data as an ICS file."""

    def __init__(self, store_path: Path) -> None:
        """Initialize the store."""
        self._store_path = store_path
        self._calendar: Calendar | None = None
        # Raw bytes kept in sync with _calendar so read-only consumers
        # never need to hit the disk again.
        self._raw_bytes: bytes = _EMPTY_ICS

    # ------------------------------------------------------------------
    # Blocking helpers — called via async_add_executor_job
    # ------------------------------------------------------------------

    def _load_sync(self) -> Calendar:
        """Load or create the ICS file (blocking)."""
        if not self._store_path.exists():
            self._store_path.parent.mkdir(parents=True, exist_ok=True)
            self._store_path.write_bytes(_EMPTY_ICS)
            self._raw_bytes = _EMPTY_ICS
        else:
            self._raw_bytes = self._store_path.read_bytes()

        cal = Calendar.from_ical(self._raw_bytes)

        # Remove any VEVENT that lacks DTSTART — these are orphaned
        # RECURRENCE-ID exceptions left by previous buggy saves.  They cause
        # repeated "skipping VEVENT without DTSTART" warnings and can confuse
        # recurring_ical_events.  Clean them up once on load and persist.
        bad = [
            c for c in cal.subcomponents
            if c.name == "VEVENT" and c.get("DTSTART") is None
        ]
        if bad:
            _LOGGER.warning(
                "local_agenda: removing %d VEVENT(s) without DTSTART "
                "(orphaned exceptions): %s",
                len(bad),
                [str(c.get("UID", "?")) for c in bad],
            )
            cal.subcomponents = [
                c for c in cal.subcomponents
                if not (c.name == "VEVENT" and c.get("DTSTART") is None)
            ]
            # Persist the cleaned calendar immediately
            self._raw_bytes = cal.to_ical()
            self._store_path.write_bytes(self._raw_bytes)

        return cal

    def _save_sync(self) -> None:
        """Write the calendar to disk and refresh raw bytes cache (blocking)."""
        if self._calendar is None:
            return
        self._raw_bytes = self._calendar.to_ical()
        self._store_path.parent.mkdir(parents=True, exist_ok=True)
        self._store_path.write_bytes(self._raw_bytes)

    # ------------------------------------------------------------------
    # Async API
    # ------------------------------------------------------------------

    async def async_load(self, hass) -> None:  # type: ignore[no-untyped-def]
        """Load the calendar from disk (non-blocking)."""
        self._calendar = await hass.async_add_executor_job(self._load_sync)

    async def async_save(self, hass) -> None:  # type: ignore[no-untyped-def]
        """Persist the calendar to disk and refresh the bytes cache (non-blocking)."""
        await hass.async_add_executor_job(self._save_sync)

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def get_calendar(self) -> Calendar:
        """Return the mutable Calendar object used for CRUD operations."""
        if self._calendar is None:
            raise RuntimeError("Calendar not loaded — call async_load first.")
        return self._calendar

    def get_calendar_for_read(self) -> Calendar:
        """Return a fresh Calendar parsed from the in-memory bytes cache.

        Always parses a new object so that libraries such as recurring_ical_events
        — which mutate components in place — never corrupt the CRUD calendar.
        No disk I/O: uses the bytes already in memory after the last load/save.
        """
        return Calendar.from_ical(self._raw_bytes)
