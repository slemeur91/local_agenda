"""Local Agenda — calendar integration with HA service actions on events."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, CONF_CALENDAR_NAME, calendar_file_key, legacy_file_key
from .store import LocalAgendaStore
from .scheduler import AgendaScheduler

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

    # Scheduler: runs on_start / on_stop at each start and end (scheduler.py)
    scheduler = AgendaScheduler(hass, entry)
    hass.data[DOMAIN][entry.entry_id]["scheduler"] = scheduler
    await scheduler.async_start()

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        data = hass.data[DOMAIN].pop(entry.entry_id, None) or {}
        if (scheduler := data.get("scheduler")) is not None:
            await scheduler.async_stop()
    return unload_ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Forget the scheduler state of a removed calendar.

    The .ics file itself is kept on purpose: recreating a calendar with the
    same name brings its events back.
    """
    from homeassistant.helpers.storage import Store

    await Store(hass, 1, f"{DOMAIN}.scheduler.{entry.entry_id}").async_remove()


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
