"""WebSocket API commands for local_agenda panel."""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Any

import voluptuous as vol
import yaml
from homeassistant.components import websocket_api
from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

from .const import CONF_CALENDAR_NAME, DOMAIN
from .actions import (
    async_validate_steps,
    parse_actions,
    set_actions_block,
    strip_actions_block,
)

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
    for command in (
        ws_occurrences,
        ws_event_get,
        ws_event_save,
        ws_event_delete,
        ws_agenda_update,
        ws_agenda_create,
        ws_history,
        ws_yaml_parse,
        ws_actions_validate,
    ):
        websocket_api.async_register_command(hass, command)


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
    """Return all local_agenda config entries with their calendar name.

    `disabled` is true when the calendar entity is disabled in Home Assistant
    (by hand or by an automation): the scheduler then runs nothing for it.
    """
    from homeassistant.helpers import entity_registry as er

    registry = er.async_get(hass)
    entries = hass.config_entries.async_entries(DOMAIN)
    result = []
    for entry in entries:
        entity_id = registry.async_get_entity_id("calendar", DOMAIN, f"local_agenda_{entry.entry_id}")
        reg_entry = registry.async_get(entity_id) if entity_id else None
        result.append(
            {
                "entry_id": entry.entry_id,
                "name": entry.title,
                "entity_id": entity_id,
                "color": entry.options.get("color"),
                "suspended": bool(entry.options.get("suspended")),
                "disabled": bool(reg_entry and reg_entry.disabled_by),
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

    # Refuse invalid actions now rather than discover them when the event
    # starts, possibly weeks later.
    errors = []
    for phase, value in new_actions.items():
        steps = value.get("actions") if isinstance(value, dict) else value
        errors += [f"{phase}, {err}" for err in await async_validate_steps(hass, steps or [])]
    if errors:
        connection.send_error(msg["id"], "invalid_format", " ; ".join(errors))
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
            entity.write_state()
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


# ---------------------------------------------------------------------------
# Panel 2.x: helpers
# ---------------------------------------------------------------------------

_WALL_FORMATS = ("%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S")


def _parse_wall(text: str, all_day: bool = False) -> date | datetime:
    """Wall-clock text from the panel → date, or datetime in HA's time zone."""
    if all_day or len(text) == 10:
        return date.fromisoformat(text[:10])
    for fmt in _WALL_FORMATS:
        try:
            naive = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return naive.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
    raise vol.Invalid(f"invalid date/time: {text}")


def _wall_to_utc(text: str) -> datetime:
    """A wall-clock date or date-time from the panel → UTC datetime."""
    value = _parse_wall(text[:16] if len(text) > 10 else f"{text[:10]}T00:00")
    return dt_util.as_utc(value)


def _entity(hass: HomeAssistant, entry_id: str):  # type: ignore[no-untyped-def]
    entities = hass.data.get(DOMAIN, {}).get(entry_id, {}).get("entities", [])
    if not entities:
        raise HomeAssistantError(f"Calendar entry {entry_id} not found")
    return entities[0]


async def _guard(connection, msg, coro_factory) -> None:  # type: ignore[no-untyped-def]
    """Send the result, or the error as a readable message."""
    try:
        result = await coro_factory()
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
    except (HomeAssistantError, ValueError, KeyError) as err:
        connection.send_error(msg["id"], "invalid", str(err) or repr(err))
    else:
        connection.send_result(msg["id"], result)


async def _validate_actions(hass: HomeAssistant, actions: dict) -> None:
    errors = []
    for phase, value in actions.items():
        steps = value.get("actions") if isinstance(value, dict) else value
        errors += [f"{phase}, {err}" for err in await async_validate_steps(hass, steps or [])]
    if errors:
        raise vol.Invalid(" ; ".join(errors))


def _clean_actions(actions: dict | None) -> dict:
    return {
        phase: value
        for phase, value in (actions or {}).items()
        if phase in ("on_start", "on_stop") and value
    }


# ---------------------------------------------------------------------------
# occurrences — every event of every Local Agenda calendar in a period
# ---------------------------------------------------------------------------


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/occurrences",
        vol.Required("start"): str,  # wall-clock, included
        vol.Required("end"): str,  # wall-clock, excluded
    }
)
@websocket_api.async_response
async def ws_occurrences(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    async def run() -> dict[str, Any]:
        start = _wall_to_utc(msg["start"])
        end = _wall_to_utc(msg["end"])
        if not start < end <= start + timedelta(days=62):
            raise vol.Invalid("invalid period (62 days at most)")
        result: dict[str, Any] = {}
        for entry in hass.config_entries.async_entries(DOMAIN):
            entities = hass.data.get(DOMAIN, {}).get(entry.entry_id, {}).get("entities", [])
            if not entities:
                continue
            result[entry.entry_id] = await hass.async_add_executor_job(
                entities[0].expand_for_panel, start, end
            )
        return {"agendas": result}

    await _guard(connection, msg, run)


# ---------------------------------------------------------------------------
# event/get — a series as the editor shows it
# ---------------------------------------------------------------------------


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/event/get",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
    }
)
@websocket_api.async_response
async def ws_event_get(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    from .calendar import wall

    async def run() -> dict[str, Any]:
        store = hass.data.get(DOMAIN, {}).get(msg["entry_id"], {}).get("store")
        if store is None:
            raise HomeAssistantError("Calendar entry not found")
        for component in store.get_calendar().walk("VEVENT"):
            if (str(component.get("uid", "")) != msg["uid"]
                    or component.get("RECURRENCE-ID") is not None):
                continue
            start = component.get("dtstart").dt
            dtend = component.get("dtend")
            end = dtend.dt if dtend is not None else start
            rrule = component.get("rrule")
            description = str(component.get("description", "") or "")
            return {
                "uid": msg["uid"],
                "summary": str(component.get("summary", "")),
                "start": wall(start),
                "end": wall(end),
                "all_day": not isinstance(start, datetime),
                "rrule": rrule.to_ical().decode("utf-8") if rrule is not None else None,
                "note": strip_actions_block(description),
                "location": str(component.get("location", "") or ""),
                "color": str(component.get("color", "") or "") or None,
                "icon": str(component.get("x-local-agenda-icon", "") or "") or None,
                "actions": parse_actions(description),
            }
        raise HomeAssistantError(f"Event {msg['uid']} not found")

    await _guard(connection, msg, run)


# ---------------------------------------------------------------------------
# event/save — create, or edit with a scope (this / future / all)
# ---------------------------------------------------------------------------

EVENT_SCHEMA = vol.Schema(
    {
        vol.Required("summary"): str,
        vol.Required("start"): str,
        vol.Required("end"): str,  # exclusive; the next day for all-day events
        vol.Optional("all_day", default=False): bool,
        vol.Optional("rrule"): vol.Any(None, str),
        vol.Optional("note", default=""): str,
        vol.Optional("location", default=""): str,
        vol.Optional("color"): vol.Any(None, str),
        vol.Optional("icon"): vol.Any(None, str),
        vol.Optional("actions", default={}): dict,
    }
)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/event/save",
        vol.Required("entry_id"): str,
        vol.Optional("uid"): vol.Any(None, str),
        vol.Optional("recurrence_id"): vol.Any(None, str),
        vol.Optional("scope", default="all"): vol.In(["this", "future", "all"]),
        vol.Optional("target_entry_id"): vol.Any(None, str),
        vol.Required("event"): dict,
    }
)
@websocket_api.async_response
async def ws_event_save(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    async def run() -> dict[str, Any]:
        event = EVENT_SCHEMA(msg["event"])
        actions = _clean_actions(event["actions"])
        await _validate_actions(hass, actions)
        start = _parse_wall(event["start"], event["all_day"])
        end = _parse_wall(event["end"], event["all_day"])
        if end <= start:
            raise vol.Invalid("the end must be after the start")
        fields: dict[str, Any] = {
            "summary": event["summary"],
            "dtstart": start,
            "dtend": end,
            "description": set_actions_block(event["note"], actions),
            "location": event["location"],
        }
        for key in ("color", "icon"):
            if key in event:
                fields[key] = event[key] or ""

        entity = _entity(hass, msg["entry_id"])
        uid = msg.get("uid")
        target = msg.get("target_entry_id") or msg["entry_id"]
        if not uid or target != msg["entry_id"]:
            # A new event, or a whole series moved to another calendar.
            if uid and msg["scope"] != "all":
                raise vol.Invalid("only a whole series can move to another calendar")
            create = {k: v for k, v in fields.items() if v not in (None, "")}
            create["summary"] = fields["summary"]
            if event.get("rrule"):
                create["rrule"] = event["rrule"]
            new_uid = await _entity(hass, target).async_create_event(**create)
            if uid:
                await entity.async_delete_event(uid)
            return {"uid": new_uid}

        if msg["scope"] == "this":
            # One occurrence: its repetition is not editable.
            await entity.async_update_event(uid, fields, recurrence_id=msg.get("recurrence_id"))
        else:
            fields["rrule"] = event.get("rrule") or ""
            await entity.async_update_event(
                uid,
                fields,
                recurrence_id=msg.get("recurrence_id") if msg["scope"] == "future" else None,
                recurrence_range="THISANDFUTURE" if msg["scope"] == "future" else None,
            )
        return {"uid": uid}

    await _guard(connection, msg, run)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/event/delete",
        vol.Required("entry_id"): str,
        vol.Required("uid"): str,
        vol.Optional("recurrence_id"): vol.Any(None, str),
        vol.Optional("scope", default="all"): vol.In(["this", "future", "all"]),
    }
)
@websocket_api.async_response
async def ws_event_delete(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    async def run() -> dict[str, Any]:
        entity = _entity(hass, msg["entry_id"])
        if msg["scope"] == "all" or not msg.get("recurrence_id"):
            await entity.async_delete_event(msg["uid"])
        else:
            await entity.async_delete_event(
                msg["uid"],
                recurrence_id=msg["recurrence_id"],
                recurrence_range="THISANDFUTURE" if msg["scope"] == "future" else None,
            )
        return {"ok": True}

    await _guard(connection, msg, run)


# ---------------------------------------------------------------------------
# Calendars: color, suspension, name, creation
# ---------------------------------------------------------------------------


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/agenda/update",
        vol.Required("entry_id"): str,
        vol.Optional("color"): vol.Any(None, str),
        vol.Optional("suspended"): bool,
        vol.Optional("name"): vol.All(str, vol.Length(min=1)),
    }
)
@websocket_api.async_response
async def ws_agenda_update(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    async def run() -> dict[str, Any]:
        entry = hass.config_entries.async_get_entry(msg["entry_id"])
        if entry is None or entry.domain != DOMAIN:
            raise HomeAssistantError("Calendar entry not found")
        options = dict(entry.options)
        for key in ("color", "suspended"):
            if key in msg:
                options[key] = msg[key]
        title = msg.get("name", "").strip() or entry.title
        hass.config_entries.async_update_entry(entry, options=options, title=title)
        # The entity name follows the title; its entity_id never changes.
        for entity in hass.data.get(DOMAIN, {}).get(entry.entry_id, {}).get("entities", []):
            entity._attr_name = title
            entity.write_state()
            entity._notify_panel_updated()
        return {"ok": True}

    await _guard(connection, msg, run)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "local_agenda/agenda/create",
        vol.Required("name"): vol.All(str, vol.Length(min=1)),
    }
)
@websocket_api.async_response
async def ws_agenda_create(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    async def run() -> dict[str, Any]:
        flow = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_USER}
        )
        result = await hass.config_entries.flow.async_configure(
            flow["flow_id"], {CONF_CALENDAR_NAME: msg["name"]}
        )
        if result.get("type") != "create_entry":
            reason = result.get("reason") or (result.get("errors") or {}).get(CONF_CALENDAR_NAME)
            raise HomeAssistantError(reason or "cannot create the calendar")
        return {"entry_id": result["result"].entry_id}

    await _guard(connection, msg, run)


# ---------------------------------------------------------------------------
# history — what the schedulers ran
# ---------------------------------------------------------------------------


@callback
@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): "local_agenda/history"})
def ws_history(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    from .calendar import wall

    items = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        scheduler = hass.data.get(DOMAIN, {}).get(entry.entry_id, {}).get("scheduler")
        if scheduler is None:
            continue
        for item in scheduler.history:
            at = dt_util.parse_datetime(item["at"])
            items.append({**item, "entry_id": entry.entry_id, "at_wall": wall(at) if at else None})
    items.sort(key=lambda i: i["at"], reverse=True)
    connection.send_result(msg["id"], items[:100])


# ---------------------------------------------------------------------------
# YAML and validation for the editor
# ---------------------------------------------------------------------------


@callback
@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "local_agenda/yaml/parse", vol.Required("text"): str}
)
def ws_yaml_parse(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    try:
        data = yaml.safe_load(msg["text"].expandtabs(2))
    except yaml.YAMLError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    connection.send_result(msg["id"], {"data": data})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): "local_agenda/actions/validate", vol.Required("actions"): list}
)
@websocket_api.async_response
async def ws_actions_validate(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    connection.send_result(msg["id"], {"errors": await async_validate_steps(hass, msg["actions"])})

