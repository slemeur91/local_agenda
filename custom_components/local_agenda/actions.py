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
Supported condition types: state, numeric_state, or, and, not.
A condition of any other type is treated as not met.

Execution
---------

The actions run through Home Assistant's script engine, so they accept the
syntax of automations (`action:` or `service:`, `delay`, `if`, `choose`,
`wait_template`, templates…) and see three variables: `agenda` (calendar
name), `phase` ("start" / "stop") and `event` (`uid`, `summary`,
`description`, `location`, `start`, `end`, `all_day`).

- A list made only of service calls — the only form up to 1.2.x — keeps its
  historical behaviour: each call runs on its own, launched in order without
  waiting for the previous one, and a failing call does not stop the others.
- Any other list runs as one script: each step waits for the previous one
  and an error stops the rest, exactly as in an automation.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import voluptuous as vol
import yaml
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import (
    SCRIPT_MODE_PARALLEL,
    Script,
    async_validate_actions_config,
)

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# Reading: the YAML sits on its own lines between the two markers.
ACTIONS_BLOCK_RE = re.compile(
    r"---actions---\s*\n(.*?)\n---/actions---", re.DOTALL
)
# Rewriting: anything between the two markers, even a block too malformed to
# be read, so that saving replaces it instead of appending a second block.
_ANY_ACTIONS_BLOCK_RE = re.compile(r"---actions---.*?---/actions---", re.DOTALL)


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


def set_actions_block(description: str | None, actions: dict[str, Any]) -> str:
    """Return `description` with its actions block replaced by `actions`.

    The block is appended when the description has none, and removed when
    `actions` is empty.  Text around the block is preserved.
    """
    description = description or ""
    if actions:
        actions_yaml = yaml.dump(
            actions, allow_unicode=True, default_flow_style=False
        )
        block = f"---actions---\n{actions_yaml}---/actions---"
    else:
        block = ""

    if _ANY_ACTIONS_BLOCK_RE.search(description):
        # A function as replacement: a plain string would have its
        # backslashes interpreted by re.sub ("\\d", "\\n", "\\1", …).
        return _ANY_ACTIONS_BLOCK_RE.sub(lambda _m: block, description).strip()
    if not block:
        return description.strip()
    sep = "\n\n" if description.strip() else ""
    return (description.strip() + sep + block).strip()


def strip_actions_block(description: str | None) -> str:
    """The description without its actions block: the free note."""
    return _ANY_ACTIONS_BLOCK_RE.sub("", description or "").strip()


# ---------------------------------------------------------------------------
# Condition evaluation
# ---------------------------------------------------------------------------

def _expected_state(value: Any) -> str:
    """Return the state text a YAML value stands for.

    Unquoted `on` / `off` / `yes` / `no` are booleans in YAML; in a state
    condition they can only mean the "on" / "off" states.
    """
    if value is True:
        return "on"
    if value is False:
        return "off"
    return str(value)


async def _check_single_condition(hass: HomeAssistant, cond: Any) -> bool:
    """Evaluate a single HA-style condition dict."""
    if not isinstance(cond, dict):
        _LOGGER.warning(
            "local_agenda: malformed condition %r — treated as not met", cond
        )
        return False
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
            return actual in [_expected_state(e) for e in expected]
        return actual == _expected_state(expected)

    if kind == "numeric_state":
        return _check_numeric_state(hass, cond)

    if kind == "or":
        for sub in cond.get("conditions") or []:
            if await _check_single_condition(hass, sub):
                return True
        return False

    if kind == "and":
        for sub in cond.get("conditions") or []:
            if not await _check_single_condition(hass, sub):
                return False
        return True

    if kind == "not":
        for sub in cond.get("conditions") or []:
            if await _check_single_condition(hass, sub):
                return False
        return True

    # Fail closed: a typo in the condition type must not turn a conditional
    # action into an unconditional one.
    _LOGGER.warning(
        "local_agenda: unsupported condition type '%s' — treated as not met", kind
    )
    return False


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _check_numeric_state(hass: HomeAssistant, cond: dict) -> bool:
    """`numeric_state`: the state (or an attribute) is above and/or below a bound.

    Same meaning as in Home Assistant: both bounds are strict, and a state
    that is not a number (unavailable, unknown…) never satisfies it.
    """
    entity_id = cond.get("entity_id")
    above = cond.get("above")
    below = cond.get("below")
    if above is None and below is None:
        _LOGGER.warning(
            "local_agenda: numeric_state on '%s' without above or below — "
            "treated as not met", entity_id,
        )
        return False
    above_n = _as_number(above) if above is not None else None
    below_n = _as_number(below) if below is not None else None
    if (above is not None and above_n is None) or (below is not None and below_n is None):
        _LOGGER.warning(
            "local_agenda: numeric_state on '%s': above/below must be numbers — "
            "treated as not met", entity_id,
        )
        return False

    state_obj = hass.states.get(entity_id)
    if state_obj is None:
        _LOGGER.debug("local_agenda: entity '%s' not found", entity_id)
        return False
    attribute = cond.get("attribute")
    raw = state_obj.attributes.get(attribute) if attribute else state_obj.state
    value = _as_number(raw)
    if value is None:
        return False
    if above_n is not None and not value > above_n:
        return False
    if below_n is not None and not value < below_n:
        return False
    return True


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
# Execution
# ---------------------------------------------------------------------------

# Keys a service call step could have up to 1.2.x (plus `action:`, the
# current name of `service:` in Home Assistant).
_SERVICE_CALL_KEYS = {"service", "action", "target", "data", "entity_id"}

# Validated Script objects, by their action list.  Home Assistant keeps every
# top-level Script it is given in a registry until shutdown, so one is built
# per distinct action list instead of one per run.
_SCRIPTS_KEY = f"{DOMAIN}_scripts"


def _is_service_call(step: Any) -> bool:
    return (
        isinstance(step, dict)
        and ("service" in step or "action" in step)
        and set(step) <= _SERVICE_CALL_KEYS
    )


def is_service_call_list(steps: list) -> bool:
    """True for a list made only of service calls (the historical format)."""
    return all(_is_service_call(step) for step in steps)


async def async_validate_steps(hass: HomeAssistant, steps: Any) -> list[str]:
    """Return a readable error for each invalid step (empty list when valid)."""
    if not isinstance(steps, list):
        steps = [steps]
    errors = []
    for index, step in enumerate(steps, start=1):
        try:
            await async_validate_actions_config(hass, cv.SCRIPT_SCHEMA([step]))
        except (vol.Invalid, HomeAssistantError) as err:
            errors.append(f"action {index}: {err}")
    return errors


async def _async_script(
    hass: HomeAssistant, steps: list, name: str
) -> Script:
    """Return the Script for `steps`, validated and built once."""
    scripts: dict[str, Script] = hass.data.setdefault(_SCRIPTS_KEY, {})
    key = json.dumps([name, steps], sort_keys=True, default=str)
    if (script := scripts.get(key)) is None:
        validated = await async_validate_actions_config(
            hass, cv.SCRIPT_SCHEMA(steps)
        )
        script = Script(
            hass,
            validated,
            name,
            DOMAIN,
            script_mode=SCRIPT_MODE_PARALLEL,
            max_runs=50,
            logger=_LOGGER,
        )
        scripts[key] = script
    return script


async def _async_run(
    hass: HomeAssistant,
    steps: list,
    name: str,
    variables: dict[str, Any],
) -> None:
    """Validate and run one script; errors are logged, never raised."""
    try:
        script = await _async_script(hass, steps, name)
    except (vol.Invalid, HomeAssistantError) as err:
        _LOGGER.error("local_agenda: invalid actions for %s: %s", name, err)
        return
    try:
        await script.async_run(run_variables=variables, context=Context())
    except Exception:  # the script engine has logged the failing step
        _LOGGER.debug("local_agenda: actions for %s stopped on an error", name)


def _start(hass: HomeAssistant, coro: Any, name: str) -> None:
    """Run a script in the background: a `delay` must not hold the scheduler."""
    hass.async_create_background_task(coro, f"{DOMAIN} {name}")


async def fire_actions(
    hass: HomeAssistant,
    phase_config: list | dict,
    event_summary: str,
    phase: str,
    variables: dict[str, Any] | None = None,
) -> str:
    """Execute the on_start or on_stop config for one event phase.

    Returns what happened: "ran", "conditions" (not met), "empty" or
    "invalid".

    Accepts either:
    - a list  → the actions (no conditions)
    - a dict  → {conditions: [...], actions: [...]}

    Conditions are evaluated here; the actions are then started in the
    background and this returns without waiting for them.
    """
    if isinstance(phase_config, list):
        steps: Any = phase_config
    elif isinstance(phase_config, dict):
        conditions = phase_config.get("conditions") or []
        steps = phase_config.get("actions") or []
        if not isinstance(conditions, list):
            conditions = [conditions]
        if conditions and not await _conditions_pass(
            hass, conditions, event_summary, phase
        ):
            return "conditions"
    else:
        _LOGGER.warning(
            "local_agenda: unexpected actions format for '%s' [%s]: %s",
            event_summary, phase, type(phase_config),
        )
        return "invalid"
    if not isinstance(steps, list):
        steps = [steps]
    # As before 1.3.0, an entry that is not a mapping is skipped on its own
    # instead of invalidating the whole list.
    for step in steps:
        if not isinstance(step, dict):
            _LOGGER.warning(
                "local_agenda: ignoring malformed action %r for '%s'", step, event_summary
            )
    steps = [step for step in steps if isinstance(step, dict)]
    if not steps:
        return "empty"

    variables = {
        "agenda": "",
        "phase": "stop" if phase == "stop" else "start",
        "event": {"summary": event_summary},
        **(variables or {}),
    }
    name = f"{variables['agenda'] or DOMAIN} – {event_summary} [{variables['phase']}]"
    _LOGGER.info("local_agenda: [%s] '%s' — %d action(s)", phase, event_summary, len(steps))

    if is_service_call_list(steps):
        # Historical behaviour: every call on its own, launched in order,
        # none waiting for or stopped by another.
        for index, step in enumerate(steps, start=1):
            _start(hass, _async_run(hass, [step], f"{name} #{index}", variables), name)
    else:
        _start(hass, _async_run(hass, steps, name, variables), name)
    return "ran"
