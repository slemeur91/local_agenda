# Local Agenda

A Home Assistant custom component that extends the local_calendar integration with the ability to trigger Home Assistant services when events start or end.

## Installation

1. Copy the `local_agenda` folder to `config/custom_components/` in your Home Assistant installation.
2. Restart Home Assistant.
3. Go to **Settings > Devices & Services > Create Automation** and add the "Local Agenda" integration.

## Actions Syntax

Events can include a special `---actions---` block in their description to define services to trigger on event start or end. The block uses YAML syntax:

```
---actions---
on_start:
  - service: domain.service_name
    target: {entity_id: switch.my_switch}
    data: {}
on_stop:
  - service: domain.service_name
    target: {entity_id: switch.my_switch}
    data: {}
---/actions---
```

Both `on_start` and `on_stop` are optional lists of service calls. Each service call supports:
- `service`: Required. Format: `domain.service_name` (e.g., `switch.turn_on`)
- `target`: Optional. Dict with entity_id or other targeting info
- `data`: Optional. Additional service parameters
- `entity_id`: Optional. Shorthand for `target: {entity_id: ...}`

## Examples

### Example 1: Turn on a switch at event start, off at event end

Event description:
```
Lawn sprinkler session

---actions---
on_start:
  - service: switch.turn_on
    entity_id: switch.lawn_sprinkler
on_stop:
  - service: switch.turn_off
    entity_id: switch.lawn_sprinkler
---/actions---
```

### Example 2: Start and dock a vacuum cleaner

Event description:
```
Vacuum cleaning

---actions---
on_start:
  - service: vacuum.start
    entity_id: vacuum.living_room
on_stop:
  - service: vacuum.return_to_base
    entity_id: vacuum.living_room
---/actions---
```

## How It Works

- The component polls every 20 seconds to check if any event start or end times fall within the current window.
- When an event's start time is reached, all actions in the `on_start` block are executed.
- When an event's end time is reached, all actions in the `on_stop` block are executed.
- Each action is fired only once per event occurrence; the component tracks fired timestamps to prevent duplicates.
- If Home Assistant is restarted, actions are re-triggered if the event time window overlaps with the polling period.
- Actions are logged at INFO level. Service call errors are logged but don't break the execution loop.

## Limitations

- Polling granularity is 20 seconds; actions fire with ~20-second accuracy.
- If Home Assistant is offline across an event boundary, retroactive firing does not occur by default.
- Event times must be in the event's `dtstart` and `dtend` fields in the ICS file.
- Recurring events work, but recurring-instance-specific overrides are expanded at load time.

## Storage

Calendar events are stored in `.storage/local_agenda.{calendar_name}.ics` to avoid collision with the stock `local_calendar` integration.
