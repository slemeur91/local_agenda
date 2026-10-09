"""Local Agenda — calendar integration with HA service actions on events."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN, CONF_CALENDAR_NAME, calendar_file_key, legacy_file_key
from .store import LocalAgendaStore
from .actions import parse_actions, fire_actions

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["calendar"]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

_PANEL_REGISTERED = False


async def async_setup(hass: HomeAssistant, config: dict) -> bool:  # type: ignore[override]
    """Register panel + WebSocket API once, before any config entry loads."""
    global _PANEL_REGISTERED
    if _PANEL_REGISTERED:
        return True

    component_dir = Path(__file__).parent

    # Serve the frontend JS files via HA's HTTP server (HA 2024+ API)
    from homeassistant.components.http import StaticPathConfig
    frontend_path = component_dir / "frontend"
    await hass.http.async_register_static_paths([
        StaticPathConfig("/local_agenda_ui", str(frontend_path), cache_headers=False)
    ])

    # Cache-bust the panel script URL with the file's mtime so that browsers
    # never keep serving a stale cached copy of panel.js after an edit + HA
    # restart — each change to the file produces a different js_url, forcing
    # a fresh fetch on the next full page reload (a plain HA restart alone
    # does NOT make an already-open browser tab re-fetch the script).
    panel_js_path = frontend_path / "panel.js"
    try:
        cache_bust = str(int(panel_js_path.stat().st_mtime))
    except OSError:
        cache_bust = "0"

    # Add "Local Agenda" to the HA sidebar — no user action needed
    try:
        from homeassistant.components.frontend import async_register_built_in_panel
        async_register_built_in_panel(
            hass,
            component_name="custom",
            sidebar_title="Local Agenda",
            sidebar_icon="mdi:calendar-edit",
            frontend_url_path="local-agenda",
            config={
                "_panel_custom": {
                    "name": "local-agenda-panel",
                    "js_url": f"/local_agenda_ui/panel.js?v={cache_bust}",
                    "embed_iframe": False,
                    "trust_external_script": False,
                }
            },
            # The panel edits what the scheduler runs with no permission
            # check of its own: it must stay reserved to administrators.
            require_admin=True,
        )
    except Exception as err:
        _LOGGER.warning("local_agenda: could not register panel: %s", err)

    # Register WebSocket API commands used by the panel
    from .ws_api import async_register_websocket_api
    async_register_websocket_api(hass)

    _PANEL_REGISTERED = True
    _LOGGER.info("local_agenda: panel and WebSocket API registered")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Local Agenda from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    name = entry.data.get(CONF_CALENDAR_NAME, "local_agenda")
    storage_dir = Path(hass.config.path(".storage"))
    store_path = storage_dir / f"local_agenda_{calendar_file_key(name)}.ics"
    legacy_path = storage_dir / f"local_agenda_{legacy_file_key(name)}.ics"
    if legacy_path != store_path:
        await hass.async_add_executor_job(
            _move_legacy_file, legacy_path, store_path
        )

    store = LocalAgendaStore(store_path)
    try:
        await store.async_load(hass)
    except (OSError, ValueError) as err:
        raise ConfigEntryError(str(err)) from err

    hass.data[DOMAIN][entry.entry_id] = {
        "store": store,
        "entities": [],
    }

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Scheduler: check every 20 s for events starting/ending
    async def _tick(now: datetime) -> None:
        await _check_actions(hass, entry)

    entry.async_on_unload(
        async_track_time_interval(hass, _tick, timedelta(seconds=20))
    )

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id, None)
        hass.data[DOMAIN].pop(entry.entry_id + "_fired", None)
    return unload_ok


def _move_legacy_file(legacy_path: Path, store_path: Path) -> None:
    """Move a calendar file saved under its pre-1.2.2 name (blocking).

    Up to 1.2.1 the calendar name went into the file name unsanitised, so a
    name containing "/" was stored in a sub-folder.  Bring such a file to its
    new location once, without ever replacing an existing file.
    """
    try:
        if legacy_path.is_file() and not store_path.exists():
            legacy_path.replace(store_path)
            _LOGGER.info(
                "local_agenda: moved calendar file %s to %s", legacy_path, store_path
            )
    except OSError as err:
        _LOGGER.warning(
            "local_agenda: could not move calendar file %s to %s: %s",
            legacy_path, store_path, err,
        )


async def _check_actions(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Fire on_start / on_stop actions for events crossing the current time."""
    from homeassistant.util import dt as dt_util

    now = dt_util.utcnow()
    window = timedelta(seconds=22)

    # Per-entry deduplication map: key -> UTC datetime at which it fired
    # (lives for the duration of the HA session).
    # Purge keys fired more than 10 minutes ago each tick to prevent unbounded
    # growth on long-running HA instances with many recurring events.  10
    # minutes is safely above the 22-second firing window, so no valid key is
    # evicted.  The purge relies on the stored datetime, never on the key
    # text: the key embeds an ISO timestamp (and possibly a UID) containing
    # ":" and expressed in the event's own timezone, so it cannot be parsed
    # or compared reliably.
    fired: dict[str, datetime] = hass.data[DOMAIN].setdefault(
        entry.entry_id + "_fired", {}
    )
    cutoff = now - timedelta(minutes=10)
    for key in [k for k, fired_at in fired.items() if fired_at < cutoff]:
        del fired[key]
    entities = hass.data[DOMAIN].get(entry.entry_id, {}).get("entities", [])

    for entity in entities:
        # Skip entities that are disabled in the HA entity registry.
        # Without this check the scheduler would fire actions from calendars
        # that the user has explicitly turned off (disabled entity).
        if not entity.enabled:
            _LOGGER.debug(
                "local_agenda: skipping action check for disabled entity '%s'",
                getattr(entity, "entity_id", "?"),
            )
            continue

        try:
            events = await entity.async_get_events(hass, now - window, now + window)
        except Exception as err:
            _LOGGER.debug("Action check failed for entity: %s", err)
            continue

        for evt in events:
            # One malformed event (bad actions block, unexpected date type…)
            # must not prevent the other events of this tick from firing.
            try:
                await _check_event(hass, entry, evt, now, window, fired)
            except Exception:
                _LOGGER.exception(
                    "local_agenda: action check failed for event '%s'",
                    getattr(evt, "summary", "?"),
                )


def _comparable(value):  # type: ignore[no-untyped-def]
    """Return a tz-aware datetime for a CalendarEvent start/end value.

    All-day values (dates) start at local midnight; a floating datetime (no
    timezone, possible in an imported .ics) is read as local time.  Without
    this, comparing it with the UTC "now" raises TypeError.
    """
    import datetime as _dt
    from homeassistant.util import dt as dt_util

    if not isinstance(value, _dt.datetime):
        return dt_util.start_of_local_day(value)
    if value.tzinfo is None:
        return value.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
    return value


async def _check_event(hass, entry, evt, now, window, fired) -> None:  # type: ignore[no-untyped-def]
    """Fire the actions of one event if it starts or ends in the window."""
    uid = getattr(evt, "uid", None) or evt.summary or "?"
    description = getattr(evt, "description", "") or ""
    actions = parse_actions(description)
    if not actions:
        return

    start = _comparable(evt.start)
    end = _comparable(evt.end)

    # Include the occurrence timestamp in the key so that different
    # occurrences of the same recurring event (same UID) each get a
    # unique deduplication entry.  Without the timestamp, the first
    # occurrence would "burn" the key for all subsequent occurrences,
    # silently preventing them from ever firing again in the same
    # HA session.
    start_key = f"{entry.entry_id}:{uid}:{start.isoformat()}:start"
    if (
        now - window <= start <= now
        and start_key not in fired
        and actions.get("on_start")
    ):
        await fire_actions(hass, actions["on_start"], evt.summary, "start")
        fired[start_key] = now

    stop_key = f"{entry.entry_id}:{uid}:{end.isoformat()}:stop"
    if (
        now - window <= end <= now
        and stop_key not in fired
        and actions.get("on_stop")
    ):
        await fire_actions(hass, actions["on_stop"], evt.summary, "stop")
        fired[stop_key] = now
