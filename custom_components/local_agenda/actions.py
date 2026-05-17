"""Action parsing and execution helpers for local_agenda.

Supported block format in event description
-------------------------------------------

Simple (backward-compatible) — just a list of service calls:

    ---actions---
    on_start:
      - service: switch.turn_on
        target: {entity_id: switch.arrosage}
    on_stop:
      - service: switch.turn_off
        target: {entity_id: switch.arrosage}
    ---/actions---

With conditions — dict with optional `conditions` + `actions` keys:

    ---actions---
    on_start:
      conditions:
        - condition: or
          conditions:
            - condition: state
              entity_id: input_select.mode
              state: Absent
            - condition: state
              entity_id: input_select.mode
              state: Travail
      actions:
        - service: vacuum.start
          target:
            entity_id:
              - vacuum.aspirateur_du_bas
              - vacuum.aspirateur_de_l_etage
    on_stop:
      actions:
        - service: vacuum.return_to_base
          target:
            entity_id:
              - vacuum.aspirateur_du_bas
              - vacuum.aspirateur_de_l_etage
    ---/actions---

Both `on_start` and `on_stop` accept either format independently.
Supported condition types: state, or, and, not.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import yaml
from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)

ACTIONS_BLOCK_RE = re.compile(
    r"---actions---\s*\n(.*?)\n---/actions---", re.DOTALL
)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_actions(description: str | None) -> dict[str, Any]:
    """Extract on_start / on_stop config from the YAML block in description.

    Returns a dict like::

        {
            "on_start": <list of service dicts>  OR  <dict with conditions+actions>,
            "on_stop":  <same>,
        }

    Returns {} if no block is found or parsing fails.
    """
    if not description:
        return {}
    match = ACTIONS_BLOCK_RE.search(description)
    if not match:
        return {}
    try:
        # YAML interdit les tabulations : on les remplace par 2 espaces
        yaml_text = match.group(1).expandtabs(2)
        parsed = yaml.safe_load(yaml_text) or {}
        result: dict[str, Any] = {}
        for phase in ("on_start", "on_stop"):
            value = parsed.get(phase)
            if value is not None:
                result[phase] = value
        return result
    except Exception as exc:
        _LOGGER.warning("local_agenda: failed to parse actions YAML: %s", exc)
        return {}


# ---------------------------------------------------------------------------
# Condition evaluation
# ---------------------------------------------------------------------------

async def _check_single_condition(hass: HomeAssistant, cond: dict) -> bool:
    """Evaluate a single HA-style condition dict."""
    kind = cond.get("condition", "")

    if kind == "state":
        entity_id = cond.get("entity_id")
        expected = cond.get("state")
        state_obj = hass.states.get(entity_id)
        if state_obj is None:
            _LOGGER.debug("local_agenda: entity '%s' not found", entity_id)
            return False
        actual = state_obj.state
        if isinstance(expected, list):
            return actual in expected
        return actual == str(expected)

    if kind == "or":
        for sub in cond.get("conditions", []):
            if await _check_single_condition(hass, sub):
                return True
        return False

    if kind == "and":
        for sub in cond.get("conditions", []):
            if not await _check_single_condition(hass, sub):
                return False
        return True

    if kind == "not":
        for sub in cond.get("conditions", []):
            if await _check_single_condition(hass, sub):
                return False
        return True

    _LOGGER.warning("local_agenda: unsupported condition type '%s'", kind)
    return True  # permissive: unknown condition doesn't block execution


async def _conditions_pass(
    hass: HomeAssistant,
    conditions: list[dict],
    summary: str,
    phase: str,
) -> bool:
    """Return True if all top-level conditions pass (implicit AND)."""
    for cond in conditions:
        if not await _check_single_condition(hass, cond):
            _LOGGER.debug(
                "local_agenda: condition not met for '%s' [%s] — skipping",
                summary, phase,
            )
            return False
    return True


# ---------------------------------------------------------------------------
# Service execution
# ---------------------------------------------------------------------------

async def _call_services(
    hass: HomeAssistant,
    service_list: list[dict[str, Any]],
    summary: str,
    phase: str,
) -> None:
    """Fire a plain list of service-call dicts."""
    for action in service_list:
        if not isinstance(action, dict):
            continue
        service_str = action.get("service", "")
        if "." not in service_str:
            _LOGGER.warning(
                "local_agenda: invalid service '%s' in actions block", service_str
            )
            continue
        domain, service_name = service_str.split(".", 1)
        target = action.get("target") or {}
        data = action.get("data") or {}
        # Shorthand: entity_id at root level
        if "entity_id" in action and "entity_id" not in target:
            target = {**target, "entity_id": action["entity_id"]}
        try:
            _LOGGER.info(
                "local_agenda: [%s] '%s' → %s.%s",
                phase, summary, domain, service_name,
            )
            await hass.services.async_call(
                domain,
                service_name,
                service_data=data,
                target=target,
                blocking=False,
            )
        except Exception as exc:
            _LOGGER.error(
                "local_agenda: error calling %s.%s for '%s': %s",
                domain, service_name, summary, exc,
            )


async def fire_actions(
    hass: HomeAssistant,
    phase_config: list | dict,
    event_summary: str,
    phase: str,
) -> None:
    """Execute the on_start or on_stop config for one event phase.

    Accepts either:
    - a list  → plain service calls (no conditions)
    - a dict  → {conditions: [...], actions: [...]}
    """
    if isinstance(phase_config, list):
        # Simple backward-compatible format
        await _call_services(hass, phase_config, event_summary, phase)

    elif isinstance(phase_config, dict):
        conditions: list[dict] = phase_config.get("conditions") or []
        service_list: list[dict] = phase_config.get("actions") or []

        if conditions:
            ok = await _conditions_pass(hass, conditions, event_summary, phase)
            if not ok:
                return

        await _call_services(hass, service_list, event_summary, phase)

    else:
        _LOGGER.warning(
            "local_agenda: unexpected actions format for '%s' [%s]: %s",
            event_summary, phase, type(phase_config),
        )
