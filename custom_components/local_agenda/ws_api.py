"""WebSocket API commands for local_agenda panel."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .actions import parse_actions, set_actions_block

_LOGGER = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def async_register_websocket_api(hass: HomeAssistant) -> None:
    """Register all WebSocket commands for the local_agenda panel."""
    websocket_api.async_register_command(hass, ws_list_calendars)
    websocket_api.async_register_command(hass, ws_get_events)
    websocket_api.async_register_command(hass, ws_get_actions)
    websocket_api.async_register_command(hass, ws_set_actions)
    websocket_api.async_register_command(hass, ws_delete_event)


# ---------------------------------------------------------------------------
# list_calendars
# ---------------------------------------------------------------------------


@callback
@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "local_agenda/list_calendars"}
)
def ws_list_calendars(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return all local_agenda config entries with their calendar name."""
    entries = hass.config_entries.async_entries(DOMAIN)
    result = []
    for entry in entries:
        entities = hass.data.get(DOMAIN, {}).get(entry.entry_id, {}).get("entities", [])
        result.append(
            {
                "entry_id": entry.entry_id,
                "name": entry.title,
                "entity_id": entities[0].entity_id if entities else None,
            }
        )
    connection.send_result(msg["id"], result)


# ---------------------------------------------------------------------------
# get_events
# ---------------------------------------------------------------------------


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/get_events",
        vol.Required("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_events(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return all events (master VEVENTs only) for a given calendar entry."""
    from icalendar import Calendar

    entry_id = msg["entry_id"]
    store = hass.data.get(DOMAIN, {}).get(entry_id, {}).get("store")
    if store is None:
        connection.send_error(msg["id"], "not_found", "Calendar entry not found")
        return

    cal: Calendar = store.get_calendar_for_read()
    events = []
    for component in cal.walk("VEVENT"):
        # Only return master VEVENTs (no RECURRENCE-ID overrides)
        if component.get("RECURRENCE-ID") is not None:
            continue
        uid = str(component.get("uid", ""))
        summary = str(component.get("summary", ""))
        description = str(component.get("description", "") or "")
        dtstart = component.get("dtstart")
        rrule = component.get("rrule")

        start_str = None
        if dtstart is not None:
            try:
                start_str = dtstart.dt.isoformat()
            except Exception:
                pass

        rrule_str = None
        if rrule is not None:
            try:
                rrule_str = rrule.to_ical().decode("utf-8")
            except Exception:
                pass

        events.append(
            {
                "uid": uid,
                "summary": summary,
                "description": description,
                "start": start_str,
                "rrule": rrule_str,
                "has_actions": bool(parse_actions(description)),
            }
        )

    events.sort(key=lambda e: (e["start"] or ""))
    connection.send_result(msg["id"], events)


# ---------------------------------------------------------------------------
# get_actions
# ---------------------------------------------------------------------------


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/get_actions",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
    }
)
@websocket_api.async_response
async def ws_get_actions(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return the parsed actions block for one event."""
    from icalendar import Calendar

    entry_id = msg["entry_id"]
    uid = msg["uid"]
    store = hass.data.get(DOMAIN, {}).get(entry_id, {}).get("store")
    if store is None:
        connection.send_error(msg["id"], "not_found", "Calendar entry not found")
        return

    cal: Calendar = store.get_calendar()
    for component in cal.walk("VEVENT"):
        if str(component.get("uid", "")) == uid and component.get("RECURRENCE-ID") is None:
            description = str(component.get("description", "") or "")
            actions = parse_actions(description)
            connection.send_result(msg["id"], {"actions": actions, "description": description})
            return

    connection.send_error(msg["id"], "not_found", f"Event {uid} not found")


# ---------------------------------------------------------------------------
# set_actions
# ---------------------------------------------------------------------------


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/set_actions",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Required("actions"): dict,  # {on_start: ..., on_stop: ...}
    }
)
@websocket_api.async_response
async def ws_set_actions(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Write an actions block into an event's description and persist.

    The block is written to the master VEVENT and to every RECURRENCE-ID
    override of the same UID.  An override carries its own copy of the
    description, and it is that copy the scheduler reads for the occurrence
    it replaces: leaving it out would keep the old actions running there.
    """
    entry_id = msg["entry_id"]
    uid = msg["uid"]
    new_actions: dict = {
        phase: value
        for phase, value in msg["actions"].items()
        if phase in ("on_start", "on_stop") and value
    }

    store = hass.data.get(DOMAIN, {}).get(entry_id, {}).get("store")
    if store is None:
        connection.send_error(msg["id"], "not_found", "Calendar entry not found")
        return

    cal = store.get_calendar()
    targets = [
        component
        for component in cal.walk("VEVENT")
        if str(component.get("uid", "")) == uid
    ]
    if not any(c.get("RECURRENCE-ID") is None for c in targets):
        connection.send_error(msg["id"], "not_found", f"Event {uid} not found")
        return

    for target in targets:
        description = str(target.get("description", "") or "")
        new_description = set_actions_block(description, new_actions)
        target.pop("description", None)
        if new_description:
            target.add("description", new_description)

    await store.async_save(hass)
    await _refresh_entities(hass, entry_id)

    connection.send_result(msg["id"], {"ok": True})


async def _refresh_entities(hass: HomeAssistant, entry_id: str) -> None:
    """Refresh the calendar entities of an entry and notify open panels.

    See LocalAgendaEntity._notify_panel_updated() for why the panel needs
    its own signal.
    """
    for entity in hass.data.get(DOMAIN, {}).get(entry_id, {}).get("entities", []):
        try:
            await entity._refresh_next_event()
            entity.async_write_ha_state()
            entity._notify_panel_updated()
        except Exception as err:
            _LOGGER.warning(
                "local_agenda: could not refresh entity after an edit: %s", err
            )


# ---------------------------------------------------------------------------
# delete_event
# ---------------------------------------------------------------------------


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/delete_event",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
    }
)
@websocket_api.async_response
async def ws_delete_event(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Delete all VEVENTs with the given UID (master event + all RECURRENCE-ID exceptions)."""
    entry_id = msg["entry_id"]
    uid = msg["uid"]

    store = hass.data.get(DOMAIN, {}).get(entry_id, {}).get("store")
    if store is None:
        connection.send_error(msg["id"], "not_found", "Calendar entry not found")
        return

    cal = store.get_calendar()
    before = len(cal.subcomponents)
    cal.subcomponents = [
        c for c in cal.subcomponents
        if not (
            c.name == "VEVENT"
            and str(c.get("uid", "")) == uid
        )
    ]
    removed = before - len(cal.subcomponents)

    if removed == 0:
        connection.send_error(msg["id"], "not_found", f"Event {uid} not found")
        return

    await store.async_save(hass)

    await _refresh_entities(hass, entry_id)

    _LOGGER.debug(
        "local_agenda: deleted %d VEVENT component(s) for uid=%s", removed, uid
    )
    connection.send_result(msg["id"], {"ok": True, "removed": removed})
