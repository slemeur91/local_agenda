"""Constants for the Local Agenda integration."""
from __future__ import annotations

import re

DOMAIN = "local_agenda"

CONF_CALENDAR_NAME = "calendar_name"

# Characters that must never reach a file name: path separators, the
# characters Windows/Samba shares reject, and control characters.
_UNSAFE_FILE_CHARS_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def legacy_file_key(name: str) -> str:
    """Return the file key used up to 1.2.1 (no sanitising)."""
    return name.lower().replace(" ", "_")


def calendar_file_key(name: str) -> str:
    """Return the part of the .ics file name derived from a calendar name.

    Identical to the historical key for ordinary names (lower case, spaces
    replaced by "_"), so existing files keep being found.  Unsafe characters
    are replaced so that a name can neither create sub-folders nor escape
    the storage directory.
    """
    return _UNSAFE_FILE_CHARS_RE.sub("_", legacy_file_key(name))
