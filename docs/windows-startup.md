# Windows administrator startup

The application owns two per-user, per-installation Task Scheduler tasks:

- `Vnite-Logon-<SID>-<installation>` uses the interactive token, highest privileges,
  a user logon trigger, and `IgnoreNew`.
- `Vnite-Launch-<SID>-<installation>` uses the same principal with no triggers and
  allows parallel short-lived dispatchers. Electron's application lock selects
  the single process that can open the databases.

Rust calls Task Scheduler through COM on a dedicated thread. Registration uses
an explicit security descriptor: the current user can read and execute, while
Administrators and SYSTEM can manage the task. The executable and working
directory are fixed when the user authorizes administrator mode.

The first change uses `ShellExecuteExW` to run the configuration helper. The helper
does not open PouchDB, does not create a window and does not acquire the application
lock. Subsequent changes use the authorized launch task. A different administrator
account is not supported; the request SID must match the process token SID.

Settings and request files are kept under
`%LOCALAPPDATA%\Vnite\startup\<installation>`, outside the database and cloud sync.
The directory retains medium integrity so the same account's normal launchers
can read state and exchange results with the administrator process. Requests
accept only launch, game/auth URL delivery, or the two startup switches.
UUID requests expire and are deduplicated. A successful `RunEx` is not treated
as proof that application initialization completed.

The administrator process confirms launch requests after the database, renderer,
tray and native initialization complete. Game requests are queued until the
renderer reports that the game database is loaded. A native monitor failure is
returned explicitly. Configuration changes are checked against the system before
being committed; failed commits restore task XML, security and compatibility flags.

## Automated checks

```sh
pnpm test:startup
pnpm typecheck
```

On Windows with the Rust MSVC toolchain:

```sh
pnpm build:native
cargo test --manifest-path native/Cargo.toml win32::autostart::tests
pnpm build:win
```

The JavaScript tests use mocked native operations for cancellation, task errors,
rollback, routing, readiness, deduplication and deferred restarts. They do not
replace the Windows checks below.

## Windows acceptance checks

1. Start the packaged application normally with both switches off. Enable
   administrator mode, accept one UAC prompt, and verify that Vnite restarts as
   one elevated main process with the original database.
2. Exit fully and double-click again. Verify no UAC prompt, an elevated process,
   and a visible main window. Repeat using a `vnite://rungameid/...` shortcut with
   Vnite closed and already running. Each request must launch the game once.
3. Enable open at login, log out and back in, and verify the elevated tray process.
   Repeat on battery power. Start and exit Genshin Impact and inspect persisted
   playtime and native ETW log messages.
4. Disable open at login while leaving administrator mode enabled. Login must not
   start Vnite, while double-click must still start it elevated without a prompt.
   Disable administrator mode, exit, and open again; the process must be normal.
5. Cancel initial authorization. Verify the switches and existing startup channel
   remain unchanged and a meaningful error is available on the next launch.
6. During a timer, save backup or restore, enable administrator mode. It must wait
   for active operations and exit persistence before restarting.
7. Disable a task, deny task access, or remove a task. Verify that the UI reports
   the actual condition, never reports an unverified disable as success, and
   exposes Repair. Repairing externally removed authorization can require UAC.
8. Repeat using Chinese characters and spaces in installation and profile paths.
   Test consecutive shortcuts, simultaneous double-clicks, and a blocked monitor.
9. Upgrade in the same installation directory. Tasks must remain valid and no new
   authorization is required. Uninstall must remove this installation's tasks
   before deleting the executable; an update must preserve them.

If external changes break automatic routing, launch
`Vnite.exe --vnite-startup-recovery` explicitly to open settings and repair.
This recovery switch does not request elevation automatically and cannot bypass
an unreadable portable database directory. Administrator mode requires a current
account in the local Administrators group; no password is stored.
