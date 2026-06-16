"""Local Agenda — calendar integration with HA service actions on events."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN, CONF_CALENDAR_NAME
from .store import LocalAgendaStore
from .actions import parse_actions, fire_actions

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["calendar"]

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
            require_admin=False,
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
    safe_name = name.lower().replace(" ", "_")
    store_path = Path(hass.config.path(".storage")) / f"local_agenda_{safe_name}.ics"

    store = LocalAgendaStore(store_path)
    await store.async_load(hass)

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
    return unload_ok


async def _check_actions(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Fire on_start / on_stop actions for events crossing the current time."""
    from homeassistant.util import dt as dt_util
    import datetime as _dt

    now = dt_util.utcnow()
    window = timedelta(seconds=22)

    # Per-entry deduplication set (lives for the duration of the HA session)
    fired: set[str] = hass.data[DOMAIN].setdefault(
        entry.entry_id + "_fired", set()
    )
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
            uid = getattr(evt, "uid", None) or evt.summary or "?"
            description = getattr(evt, "description", "") or ""
            actions = parse_actions(description)
            if not actions:
                continue

            start = evt.start
            end = evt.end

            if isinstance(start, _dt.date) and not isinstance(start, _dt.datetime):
                start = dt_util.start_of_local_day(start)
            if isinstance(end, _dt.date) and not isinstance(end, _dt.datetime):
                end = dt_util.start_of_local_day(end)

            # Include the occurrence timestamp in the key so that different
            # occurrences of the same recurring event (same UID) each get a
            # unique deduplication entry.  Without the timestamp, the first
            # occurrence would "burn" the key for all subsequent occurrences,
            # silently preventing them from ever firing again in the same
            # HA session.
            start_iso = start.isoformat() if isinstance(start, _dt.datetime) else str(start)
            end_iso   = end.isoformat()   if isinstance(end,   _dt.datetime) else str(end)

            start_key = f"{entry.entry_id}:{uid}:{start_iso}:start"
            if (
                now - window <= start <= now
                and start_key not in fired
                and actions.get("on_start")
            ):
                await fire_actions(hass, actions["on_start"], evt.summary, "start")
                fired.add(start_key)

            stop_key = f"{entry.entry_id}:{uid}:{end_iso}:stop"
            if (
                now - window <= end <= now
                and stop_key not in fired
                and actions.get("on_stop")
            ):
                await fire_actions(hass, actions["on_stop"], evt.summary, "stop")
                fired.add(stop_key)
