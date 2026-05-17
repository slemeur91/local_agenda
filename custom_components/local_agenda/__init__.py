"""Local Agenda — calendar integration with HA service actions on events."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN, CONF_CALENDAR_NAME
from .store import LocalAgendaStore
from .actions import parse_actions, fire_actions

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["calendar"]

_PANEL_REGISTERED = False

# ---------------------------------------------------------------------------
# Brand icon views
# ---------------------------------------------------------------------------
# Le frontend HA charge l'icône de marque via plusieurs URL selon le contexte :
#   icon.png      → carte intégration (panneau Appareils & Services)
#   logo.png      → page de détail de l'intégration / appareil
#   icon@2x.png   → variante haute résolution de l'icône
#   logo@2x.png   → variante haute résolution du logo
# On enregistre une vue pour chacune afin de couvrir tous les emplacements.
_BRAND_ASSETS = ["icon.png", "logo.png", "icon@2x.png", "logo@2x.png"]


def _make_brand_view(asset: str, icon_data: bytes) -> HomeAssistantView:
    """Fabrique une HomeAssistantView pour une URL de marque donnée."""
    safe_name = asset.replace(".", "_").replace("@", "_at_")

    class _BrandView(HomeAssistantView):
        url = f"/api/brands/integration/{DOMAIN}/{asset}"
        name = f"api:brands:integration:{DOMAIN}:{safe_name}"
        requires_auth = False

        async def get(self, request: web.Request) -> web.Response:
            return web.Response(
                body=icon_data,
                content_type="image/png",
                headers={"Cache-Control": "no-cache, no-store"},
            )

    return _BrandView()


async def async_setup(hass: HomeAssistant, config: dict) -> bool:  # type: ignore[override]
    """Register panel + WebSocket API once, before any config entry loads."""
    global _PANEL_REGISTERED
    if _PANEL_REGISTERED:
        return True

    component_dir = Path(__file__).parent

    # -- Icônes de marque ---------------------------------------------------
    icon_file = component_dir / "icon.png"
    if icon_file.exists():
        try:
            icon_data: bytes = await hass.async_add_executor_job(icon_file.read_bytes)
            for asset in _BRAND_ASSETS:
                hass.http.register_view(_make_brand_view(asset, icon_data))
                _LOGGER.debug(
                    "local_agenda: vue brand enregistrée : /api/brands/integration/%s/%s (%d bytes)",
                    DOMAIN, asset, len(icon_data),
                )
        except Exception as err:
            _LOGGER.warning("local_agenda: impossible d'enregistrer les vues brand : %s", err)
    else:
        _LOGGER.warning(
            "local_agenda: icon.png introuvable dans %s — les icônes ne s'afficheront pas",
            component_dir,
        )

    # Serve the frontend JS files via HA's HTTP server (HA 2024+ API)
    from homeassistant.components.http import StaticPathConfig
    frontend_path = component_dir / "frontend"
    await hass.http.async_register_static_paths([
        StaticPathConfig("/local_agenda_ui", str(frontend_path), cache_headers=False)
    ])

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
                    "js_url": "/local_agenda_ui/panel.js",
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
