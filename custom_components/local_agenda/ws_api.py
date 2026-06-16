"""WebSocket API commands for local_agenda panel."""
from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .actions import parse_actions

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
    websocket_api.async_register_command(hass, ws_get_ha_services)
    websocket_api.async_register_command(hass, ws_get_ha_entities)


# ---------------------------------------------------------------------------
# list_calendars
# ---------------------------------------------------------------------------


@callback
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

    cal: Calendar = store.get_calendar()
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
    """Write an actions block into an event's description and persist."""
    import re
    import yaml as _yaml

    entry_id = msg["entry_id"]
    uid = msg["uid"]
    new_actions: dict = msg["actions"]

    store = hass.data.get(DOMAIN, {}).get(entry_id, {}).get("store")
    if store is None:
        connection.send_error(msg["id"], "not_found", "Calendar entry not found")
        return

    cal = store.get_calendar()
    target = None
    for component in cal.walk("VEVENT"):
        if str(component.get("uid", "")) == uid and component.get("RECURRENCE-ID") is None:
            target = component
            break

    if target is None:
        connection.send_error(msg["id"], "not_found", f"Event {uid} not found")
        return

    # Serialise new actions to YAML
    actions_yaml = _yaml.dump(new_actions, allow_unicode=True, default_flow_style=False)
    actions_block = f"---actions---\n{actions_yaml}---/actions---"

    # Update description: replace existing block or append
    description = str(target.get("description", "") or "")
    block_re = re.compile(r"---actions---.*?---/actions---", re.DOTALL)
    if block_re.search(description):
        new_description = block_re.sub(actions_block, description).strip()
    else:
        sep = "\n\n" if description.strip() else ""
        new_description = (description.strip() + sep + actions_block).strip()

    target.pop("description", None)
    if new_description:
        target.add("description", new_description)

    await store.async_save(hass)

    # Refresh entities cache
    for entity in hass.data.get(DOMAIN, {}).get(entry_id, {}).get("entities", []):
        try:
            await entity._refresh_next_event()
            entity.async_write_ha_state()
        except Exception:
            pass

    connection.send_result(msg["id"], {"ok": True})


# ---------------------------------------------------------------------------
# delete_event
# ---------------------------------------------------------------------------


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

    # Refresh entities so HA state reflects the deletion immediately, and
    # notify any open Local Agenda panel (this tab or another) so its event
    # list refreshes too — see LocalAgendaEntity._notify_panel_updated().
    for entity in hass.data.get(DOMAIN, {}).get(entry_id, {}).get("entities", []):
        try:
            await entity._refresh_next_event()
            entity.async_write_ha_state()
            entity._notify_panel_updated()
        except Exception:
            pass

    _LOGGER.debug(
        "local_agenda: deleted %d VEVENT component(s) for uid=%s", removed, uid
    )
    connection.send_result(msg["id"], {"ok": True, "removed": removed})


# ---------------------------------------------------------------------------
# get_ha_services
# ---------------------------------------------------------------------------


@callback
@websocket_api.websocket_command(
    {vol.Required("type"): "local_agenda/get_ha_services"}
)
def ws_get_ha_services(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return all registered HA services (domain + service name + fields schema)."""
    result = []
    for domain, services in hass.services.async_services().items():
        for service_name, service_obj in services.items():
            fields = {}
            if hasattr(service_obj, "schema") and service_obj.schema is not None:
                try:
                    # Extract field names from voluptuous schema
                    schema = service_obj.schema
                    if hasattr(schema, "schema"):
                        for key in schema.schema:
                            field_name = str(key)
                            fields[field_name] = {}
                except Exception:
                    pass
            result.append(
                {
                    "domain": domain,
                    "service": service_name,
                    "full": f"{domain}.{service_name}",
                    "fields": list(fields.keys()),
                }
            )
    result.sort(key=lambda s: s["full"])
    connection.send_result(msg["id"], result)


# ---------------------------------------------------------------------------
# get_ha_entities
# ---------------------------------------------------------------------------


@callback
@websocket_api.websocket_command(
    {vol.Required("type"): "local_agenda/get_ha_entities"}
)
def ws_get_ha_entities(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Return all entity_ids with their current state."""
    result = [
        {"entity_id": state.entity_id, "state": state.state, "domain": state.domain}
        for state in hass.states.async_all()
    ]
    result.sort(key=lambda e: e["entity_id"])
    connection.send_result(msg["id"], result)
