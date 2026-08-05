# AdRouter Agent Privacy

Effective: 12 July 2026

AdRouter Agent is a local-first desktop coding agent. It does not include
telemetry, analytics, advertising trackers, crash-upload services, or automatic
update checks.

## Data stored on the device

The app stores project references, chat history, approvals, settlements, and
change-review baselines in its local application-data directory. The router
access token is encrypted with Keychain on macOS, DPAPI on Windows, or a
supported desktop secret store on Linux. Project files remain in the
folders selected by the user.

## Data sent to AdRouter

To perform an agent turn, the app sends the task, relevant conversation and
workspace context, tool descriptions, and tool results to the AdRouter server
configured by the user. AdRouter's operator controls how that server and its
model providers process or retain the request. Users should review the privacy
terms supplied by their router operator before connecting.

Sponsor selection, display payloads, and settlement information are kept out
of model prompts, tool arguments, commands, file edits, and compacted agent
context. Sponsor links are opened only after the user explicitly selects them.

## Network behavior

Background requests are limited to the configured AdRouter server's health,
profile, model-discovery, and agent-turn routes. Remote routers must use HTTPS;
plain HTTP is accepted only for loopback development servers. The app does not
contact GitHub or another service to check for updates.

## User control

Users can delete chat history from the app and can remove all application data
using the standard operating-system application-data controls. Removing the app does not
delete project folders or files.
