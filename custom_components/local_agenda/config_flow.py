"""Config flow for Local Agenda."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers import config_validation as cv

from .const import CONF_CALENDAR_NAME, DOMAIN


class LocalAgendaConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle the setup config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> config_entries.ConfigFlowResult:
        """Handle the initial step shown to the user."""
        errors: dict[str, str] = {}

        if user_input is not None:
            name: str = user_input[CONF_CALENDAR_NAME].strip()
            if not name:
                errors[CONF_CALENDAR_NAME] = "invalid_name"
            else:
                await self.async_set_unique_id(f"local_agenda_{name.lower()}")
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=name, data=user_input)

        data_schema = vol.Schema(
            {
                vol.Required(CONF_CALENDAR_NAME, default="Mon agenda"): cv.string,
            }
        )

        return self.async_show_form(
            step_id="user",
            data_schema=data_schema,
            errors=errors,
        )
