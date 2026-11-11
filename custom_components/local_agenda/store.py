"""Store calendar data and provide access."""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
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
        # (bytes, Calendar parsed from them) for the readers.
        self._read_cache: tuple[bytes, Calendar] | None = None
        # Serialises disk writes so two saves can never interleave.
        self._write_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Blocking helpers — called via async_add_executor_job
    # ------------------------------------------------------------------

    def _write_sync(self, raw: bytes) -> None:
        """Write the file atomically (blocking).

        The bytes go to a temporary file in the same directory which then
        replaces the real one, so a crash or power cut during the write
        leaves the previous version intact instead of a truncated file.
        """
        directory = self._store_path.parent
        directory.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            dir=directory, prefix=self._store_path.name + ".", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "wb") as tmp_file:
                tmp_file.write(raw)
                tmp_file.flush()
                os.fsync(tmp_file.fileno())
            os.replace(tmp_name, self._store_path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def _load_sync(self) -> Calendar:
        """Load or create the ICS file (blocking)."""
        if not self._store_path.exists():
            self._write_sync(_EMPTY_ICS)
            self._raw_bytes = _EMPTY_ICS
        else:
            self._raw_bytes = self._store_path.read_bytes()

        try:
            cal = Calendar.from_ical(self._raw_bytes)
        except Exception as err:
            # Never overwrite or "repair" an unreadable file: it is the only
            # copy of the user's events.  Fail loudly and leave it untouched.
            raise ValueError(
                f"local_agenda: the calendar file {self._store_path} cannot be "
                f"read as iCalendar ({err}). The file was left untouched."
            ) from err

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
            self._write_sync(self._raw_bytes)

        return cal

    # ------------------------------------------------------------------
    # Async API
    # ------------------------------------------------------------------

    async def async_load(self, hass) -> None:  # type: ignore[no-untyped-def]
        """Load the calendar from disk (non-blocking)."""
        self._calendar = await hass.async_add_executor_job(self._load_sync)

    async def async_save(self, hass) -> None:  # type: ignore[no-untyped-def]
        """Persist the calendar to disk and refresh the bytes cache.

        The calendar is serialised here, on the event loop, where it is also
        mutated: serialising it in a worker thread could read it half-way
        through another edit.  Only the disk write goes to the executor.
        """
        if self._calendar is None:
            return
        raw = self._calendar.to_ical()
        self._raw_bytes = raw
        async with self._write_lock:
            # Write the newest snapshot: a save queued behind another one
            # must not put an older version back on disk.
            await hass.async_add_executor_job(self._write_sync, self._raw_bytes)

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def get_calendar(self) -> Calendar:
        """Return the mutable Calendar object used for CRUD operations."""
        if self._calendar is None:
            raise RuntimeError("Calendar not loaded — call async_load first.")
        return self._calendar

    def get_calendar_for_read(self) -> Calendar:
        """Return a Calendar parsed from the last saved bytes, for reading.

        It is a separate object from the CRUD calendar, so an edit in
        progress is never seen half-way.  It is parsed once per saved
        version and shared by the readers (the scheduler every 20 s, the
        panel, Home Assistant's calendar): they must not modify it.
        recurring_ical_events does not — it builds new components for the
        occurrences it returns.  No disk I/O.
        """
        raw = self._raw_bytes
        cached = self._read_cache
        if cached is not None and cached[0] is raw:
            return cached[1]
        cal = Calendar.from_ical(raw)
        self._read_cache = (raw, cal)
        return cal
