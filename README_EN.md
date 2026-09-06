# Action Editor

[中文](README.md) | [English](README_EN.md)

Action Editor is a standalone Electron desktop application for controlling the facial-expression motors of an animatronic face robot. It provides Protocol 6 CAN control for individual motors, a motor-control timeline, a named-action editor, and a multi-track action timeline. The project includes its own JavaScript bridge client and a pure-standard-library Python SocketCAN bridge, and does not depend on any other LumDriver source directory.

Real CAN operation targets Linux SocketCAN. The interface and protocol flow can also be developed, demonstrated, and tested in simulation mode. Before working with real machinery, read the [Hardware Safety Guide](SAFETY.md).

The current application interface is Chinese. English control names in this document describe the corresponding labels in the GUI; they do not indicate that the interface itself has been localized.

## Quick Start

Requirements:

- Node.js 24.20.0 or a later compatible version (Node 24 LTS is recommended);
- npm 11.19.0 (included with the official Node 24.20.0 distribution);
- Python 3.9 or later;
- Real CAN: Linux, an enabled SocketCAN interface, and the appropriate hardware driver.

After cloning or downloading the repository, run the following commands from the project root:

```bash
cd action-editor
npm ci
npm start
```

When checking the interface for the first time, you can enable **Simulation** in the top bar; no CAN hardware is required. Before development work or submitting changes, run:

```bash
npm run verify
```

On Linux desktops, install a shortcut that always points to the current project directory with:

```bash
npm run desktop:install
```

If the desktop session's `PATH` cannot find Node.js, `scripts/run.sh` will also check `$HOME/.local/nodejs/node-v*/bin/node`. You can instead specify the Node executable with `ACTION_EDITOR_NODE`; the former `LUMMOTOR_NODE` remains available as a compatibility alias. Override the Python interpreter with `ACTION_EDITOR_PYTHON`; the former `LUMDRIVER_PYTHON` remains supported as well.

## Preparing SocketCAN

Action Editor does not invoke `sudo` and does not configure the system CAN bit rate. The following is a typical system configuration for `can0` at 1 Mbit/s; adjust the commands for the CAN adapter in use:

```bash
sudo ip link set can0 down 2>/dev/null || true
sudo ip link set can0 up type can bitrate 1000000
ip -details link show can0
```

The current user must also have permission to access the interface. Do not run multiple programs that can send motion commands on the same bus at the same time.

## Project Structure

```text
action-editor/
├── README.md / README_EN.md # Chinese / English documentation
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # Copyright and attribution notices
├── main.js                  # Electron main process, security validation, and file dialogs
├── preload.js               # Minimal renderer API
├── renderer/                # Single-window GUI
├── src/                     # Motor, command, timeline models, and bridge client
├── bridge/                  # Python SocketCAN / simulation bridge
├── scripts/                 # Portable launcher and desktop-shortcut installer
├── tests/                   # Node regression and standalone bridge simulation tests
└── .github/                 # CI, dependency updates, and collaboration templates
```

On Linux, Action Editor continues to use the legacy configuration directory `~/.config/lumdriver-motor-terminal`, so existing motor IDs, actions, and timelines are preserved during application upgrades. The directory name is retained only for backward compatibility with existing local data; it is not the current product name or a source-code dependency.

## Using Action Editor

Action Editor is a single-window Protocol 6 CAN command terminal. All current motors are expanded on one page, with no need to select a motor and then enter a separate control page. When creating a motor, first choose its name and group; both become fixed after creation. Each row directly configures the node ID, relative step count, speed, acceleration, and open-loop/closed-loop mode, and can independently move forward, move in reverse, stop, or disable the motor.

## Motor Positions

On first launch, the application provides 26 physical motor positions:

- 4 eyebrow motors: left outer eyebrow, left inner eyebrow, right inner eyebrow, and right outer eyebrow;
- 4 left-eye motors: upper eyelid, lower eyelid, horizontal eyeball movement, and vertical eyeball movement;
- 4 right-eye motors: upper eyelid, lower eyelid, horizontal eyeball movement, and vertical eyeball movement;
- 9 mouth motors: left mouth corner A/B, right mouth corner A/B, upper lip left/right, lower lip left/right, and jaw;
- 5 head and neck motors: left linkage, right linkage, head turn, head turn 2, and neck.

Use **+ Add Motor** in the **Motor Control** title area to add more control positions. The dialog first asks for a name and group. After a motor is created, neither its name nor group can be edited. To rename it or move it to another group, delete the motor and add it again with the correct name in the target group. Use **+ Add Group** to create a control group; group names remain directly editable. **+ Motor** in a group heading preselects that group. Groups on the Motor Control page are laid out continuously in two columns, with no large vertical gaps caused by groups of different heights. Empty groups can be deleted directly; all motors in a nonempty group must be deleted first. The motor and group lists, names, IDs, and motion parameters are automatically saved locally, so the previous layout and configuration are restored after restarting the application.

The `ID` field in each row binds a CAN node ID in the range `1..127`. The same ID may be entered for multiple positions, which makes it possible to send short-travel commands one row at a time while identifying the corresponding mechanism. Leave the field empty when a position is not in use. Valid IDs and parameters are saved locally as soon as they change, and the top-bar status shows **IDs and parameters saved**. A save failure is also reported immediately. Each motor position independently stores its ID, step count, speed, acceleration, and selected open-loop/closed-loop mode. This does not change the node ID stored on the driver board itself. If a motor's ID is changed, historical commands that retain the old ID are marked invalid and cannot be sent, preventing unintended control of another node.

Duplicate IDs are allowed. When identifying motors, begin with a low speed and a small step count, and make sure no one and no obstruction is near the mechanism.

## Importing and Exporting Configuration

Use **Export Configuration** and **Import Configuration** at the left of the top bar to move settings between devices or debugging configurations. The exported JSON file contains the CAN interface, simulation setting, group names and order, and the name, group, ID, step count, speed, acceleration, and open-loop/closed-loop mode of every current motor. It does not contain command history, the send log, the current position, connection state, or Motor Control Timeline enable states.

CAN must be disconnected before importing. Action Editor fully validates the file format, version, motor list, and parameter ranges before applying and saving the entire configuration as one operation. Duplicate IDs are preserved exactly, and a validation failure does not change the current configuration. Earlier fixed-axis configuration exports remain importable; new default positions that are absent are added according to the compatibility rules. Importing a new configuration invalidates position accumulation for the current connection. Reconnect, or set the current position as the origin after confirming that the mechanism is safe. If an older configuration does not contain motion-mode fields, it is loaded as open-loop so that historical configurations are not accidentally changed to closed-loop.

## Motor Control Timeline

**Motor Control Timeline** is the second workspace. The CAN connection controls, configuration tools, and all-bus emergency stop remain available at the top. Timeline tracks list all current motor positions in Motor Control group order, separated by group headings. Every position (track) has an independent timeline-enable switch that is off by default. This switch only determines whether the corresponding track participates in testing and playback; it does not restrict manual operation on the Motor Control page.

Click the motor name or empty track area on the right to select that position. The entire selected row is highlighted, and the action editor on the left shows the current control position; there is no motor drop-down that can unexpectedly jump back to an old value. Then set the direction, open-loop/closed-loop mode, start time, step count, speed, and acceleration. **Test Action** immediately sends the current parameters to that position once, but does not automatically add the test to the timeline. Clicking the enable checkbox changes only playback enablement and does not change the selected control position. **Add as New Action** always creates a new timeline point, so any number of actions can be added repeatedly for the same motor. After selecting an existing action, **Update Selected Action** modifies only that action and does not overwrite other timeline points for the same motor. The action editor no longer has a separate **New** button. To add another action, simply select a motor row, adjust the parameters, and click **Add as New Action**.

The horizontal axis represents command send time, and the vertical axis lists the current motor positions. Drag an action marker left or right to change its send time, or drag it vertically to another position that has a configured ID. Actions snap to 100 ms by default; hold `Alt` while dragging to temporarily disable snapping. Drag the top time ruler or yellow playhead left or right to write the selected time into **Start Time / ms** in the editor. When editing an existing action, this changes only the editor draft; click **Update Selected Action** to save it. Selected or hovered markers expand to show their action parameters. Click an action block to load it in the editor and enter editing mode. Click a motor row again to return to new-action mode for that motor. Actions, duration, snapping, and zoom settings are saved automatically. You can also click **Save Timeline** to save immediately and view the action count.

The action editor calculates the theoretical duration and estimated end time in real time from the step count, speed level, and acceleration level. Timeline actions are no longer displayed as points; each is shown as an action block whose length reflects its theoretical duration. The calculation uses the same squared level mapping and S-curve model as the Protocol 6 firmware. After CAN is connected, Action Editor reads each node's full steps per revolution, microstep subdivision, S-curve time, speed limit, and acceleration limit without modifying them, and recalculates the duration. When offline or when a node does not respond, it uses the firmware defaults: 200 full steps, 128 microsteps, 3,000 rpm, 20,000 rpm/s, and a 10 ms S-curve. The interface clearly identifies the parameter source.

For an open-loop action, the theoretical duration corresponds to the completion time of the reference S-curve. The duration shown for a closed-loop action also represents only this reference trajectory and must not be treated as the actual closed-loop arrival time. Closed-loop execution can also include current precharge, a safe open-loop/closed-loop handover, and encoder correction and stability detection after the trajectory stops. Under a heavy load, it can continue occupying the FIFO while waiting to reach the target. Closed-loop action blocks and **Append after last action on same ID** are therefore scheduling aids only. Final completion must still be determined from node status and FIFO feedback.

If an action's send time is earlier than the estimated end time of the previous action for the same physical ID, its block is shown as queued. During firmware playback, it enters that node's FIFO instead of physically starting at that point on the horizontal axis. **Append after last action on same ID** places the start time at the current estimated completion point for that ID, rounded up to the snap interval, which helps arrange consecutive actions for the same motor. Action blocks for different IDs may overlap to indicate parallel motion. Duration is for scheduling reference and does not replace arrival feedback: load, lost steps, travel limits, faults, CAN latency, or commands inserted by another controller can all change the actual completion time.

**Export Animation** creates a standalone motor-timeline JSON file containing total duration, snapping, zoom, the enable state of every current track, and every action's motor position, node ID, time, signed direction/step count, speed, and acceleration. It is separate from the hardware configuration exported from the top bar. Each action's open-loop/closed-loop selection is saved and exported with it. **Import Animation** fully validates the file format, version, action count, and all parameters before replacing the entire current timeline and track-enable state and saving it. Motor Control Timeline content and enable states are also saved locally automatically; they are not part of the top-bar motor configuration. Importing an animation does not change current motor-ID bindings. If an action ID in the file differs from the current binding, that action is marked invalid and cannot be played until it is updated. Older 25-axis animation files remain importable; the **Head Turn 2** track is automatically added in a disabled state with no actions. Actions in older animation files that do not include a motion mode are imported as open-loop to preserve their original send behavior.

Enabled-track actions that target different physical nodes at the same time are dispatched concurrently as a group, allowing facial expressions to be scheduled with approximately simultaneous starts. The CAN bus is still a serial link, and the current firmware has no timestamped hardware synchronization trigger. The horizontal axis therefore guarantees only that the host sends at the scheduled time; it cannot promise that multiple motors begin moving at the exact same physical instant. Enabled actions at the same time that target the same node ID are highlighted in red and prevent playback because they share one MCU FIFO. Actions on disabled tracks do not participate in playback, time-conflict detection, or same-node conflict detection.

Actions on disabled tracks can still be added, modified, dragged, saved, and exported. **Test Action** requires the selected action's track to be enabled. Playback sends actions only from enabled tracks and skips disabled tracks without preventing the timeline from starting. Disabling a track affects only future playback; it does not stop an action that is already playing or has already entered a driver-board queue. Timeline-enable switches are locked in the interface during playback.

Click **Stop** at any time during playback. Action Editor first cancels actions that have not yet been dispatched, then broadcasts an immediate STOP and sends an addressed STOP to every involved node. Normal playback ends only after the final action sequence has completed, Status A reports no fault, and the Status D FIFO is empty. Long programs are not limited to 64 actions in total. During playback, Action Editor protects each node according to its reported FIFO capacity and fill level. If an interface or system stall makes an action more than 250 ms late, Action Editor performs a protective stop instead of dispatching all overdue actions at once. Tests, playback, and stops are added to the send log. Successfully acknowledged movements are also added to the current connection's origin ledger.

Before sending a closed-loop test or playing a timeline that contains closed-loop actions, the GUI rereads the relevant node states and checks that the encoder is valid and that encoder calibration is valid. No closed-loop action is sent if either condition is not met. The MCU still performs the final validation of closed-loop execution requirements—such as run current, position-loop gains, and speed-loop gains—when it receives a motion frame. GUI preflight checks do not replace firmware safety interlocks.

## Action Editor

**Action Editor** combines one or more motor movements into a reusable named action, such as **Blink**, **Smile**, or **Nod**. Each motor movement independently stores its motor position, relative start time, direction, step count, speed, acceleration, and open-loop/closed-loop mode. One action can contain multiple motors, and the same motor can move multiple times in sequence at different times. Before saving an action, you can immediately test the current motor movement or test the complete action according to its relative timing.

Every named action has its own internal mini timeline. Lanes are derived from logical motor positions: multiple movements for the same motor share one lane, while different motors remain on separate lanes even if they currently use the same CAN ID. Click a movement block to load it into the parameter editor, or drag it horizontally to change its relative start time. Dragging follows the local snap setting; hold `Alt` to temporarily disable snapping. Visually overlapping blocks are automatically stacked inside that motor's lane so every movement remains selectable and removable. A drag changes only the current draft until **Save Current Action** is clicked, at which point existing Action Timeline instances begin using the updated definition. Drag the ruler or playhead to choose the start time for a new movement. During a complete-action test, this mini timeline's playhead follows the scheduler.

The interface calculates the theoretical duration of every segment from its motor-motion parameters and presents the whole action's theoretical duration as the estimated end time of the final segment. When CAN is connected, it prefers read-only motion parameters obtained from the node. When offline, it uses the same firmware defaults as Motor Control Timeline. Theoretical duration is only a scheduling reference; actual closed-loop arrival must still be determined from node status and FIFO feedback.

Named actions are automatically saved locally. After a saved action is modified, existing instances of that action on Action Timeline immediately use the new definition. If a motor ID changes, movements that retain the old ID are marked invalid and cannot be tested or played until updated. When a motor is deleted, every named action containing that motor is deleted in its entirety, together with its Action Timeline instances, preventing an incomplete facial expression that executes only one side.

## Action Timeline

**Action Timeline** schedules only named actions and does not display editors for individual-motor step count, speed, or other parameters. First save actions in **Action Editor**. They then appear in the searchable card library on the left side of the page. Click a card to select an action. On the right, action tracks can be freely added, renamed, and deleted; click a track to make it the current target. Click the `+` on the right side of a card, double-click a card, or click the bottom button to add the action at the current playhead position on the target track. You can also drag a card directly to a specific time on any track. Dragging follows the current snap setting; hold `Alt` to disable snapping temporarily. The same named action can be added any number of times on any track. Drag a placed action block left or right to change its start time, or vertically to move it to another track. Actions on different tracks may begin at the same time, allowing eyebrow, eye, mouth, and head actions to run in parallel. **Clear** deletes only action instances and preserves the tracks. Deleting a track that contains actions explicitly warns that its instances will also be deleted. Track names, track order, duration, snapping, zoom, and all action instances are saved automatically. Legacy single-track data is automatically migrated to editable tracks the first time it is loaded.

Use **Save Timeline** at the top of the page to immediately save the current named-action library, tracks, and action instances locally. **Export Animation** creates a standalone Action Timeline JSON file. It contains every named-action definition from Action Editor, a snapshot of motor-position references, track names and order, action instances, total duration, snapping, and zoom settings, so no action material is missing when the file is copied to another device. **Import Animation** fully validates the entire file and the references between actions, tracks, and instances before replacing the current named-action library and Action Timeline as one operation and saving it. A validation failure does not change the existing project. If the current action draft has unsaved changes, Action Editor explicitly prompts before replacement. Importing does not modify the current motor configuration or CAN node bindings. An import is rejected if the current configuration lacks a motor position referenced by the file. Movements whose node IDs have changed are marked invalid and cannot be tested or played until updated. This file is independent of the per-motor animation file exported by Motor Control Timeline; the two formats cannot be interchanged.

During playback, Action Editor expands every named action into its motor movements and reuses Motor Control Timeline's concurrent dispatch, acknowledgements, FIFO fill-level protection, lateness protection, fault shutdown, and all-bus emergency-stop path. A named action executes as a whole and does not read Motor Control Timeline's track-enable switches, so a Blink action cannot execute only one side because the other side's track is disabled. Movements for different physical IDs at the same time are dispatched concurrently as a group. Tracks are only a visual scheduling device and are not played sequentially one by one. Multiple movements for the same physical ID at the same time are highlighted in red and prevent playback even when they are on different tracks, avoiding contention for the same MCU FIFO.

## Command Semantics

The terminal uses LumDriver Protocol 6 Format 6 for open-loop or closed-loop relative motion. Both modes have the same 8-byte payload layout; the mode is selected by the standard CAN arbitration ID: `0x200 | node` for open-loop and `0x280 | node` for closed-loop.

- Relative step count: `1..16777215`; enter only the travel distance in the field, and use the `+`/`-` button to choose direction;
- Speed level: `1..100`;
- Acceleration level: `1..100`.

Each motor row can select open-loop or closed-loop operation, and the selected mode is stored with the command. Every timeline action can independently select its mode as well. In each row, `+` moves forward by the current step count, `-` moves in reverse by the current step count, `■` immediately stops that motor, and **Off** disables that motor in hardware. The Motor Control page is not affected by Motor Control Timeline enable states. Every successfully triggered forward or reverse movement is automatically added to the command history on the right. Sending waits for a hardware acknowledgement from the corresponding node with the matching motion sequence, with a one-second timeout. Only an acknowledged command is added to the origin ledger. Failed sends are still written to the log but are not retained in the resendable history.

Click **Send All Recorded Commands in Order** to immediately take a snapshot of the history, assign each command a new motion sequence, send them one by one, and wait for acknowledgements; there is no second confirmation dialog. **Clear** also deletes resendable history immediately. Neither operation recursively appends to the history. Sending stops after any command fails. Pressing a row's stop or disable button, or the all-bus emergency stop in the top bar, during batch playback also cancels all later commands that have not yet been sent. Actions already accepted by nodes may still execute. Each node's MCU FIFO holds 64 entries, so the terminal refuses to replay more than 64 recorded commands to one node in a single batch. Resending one record and **Send All Recorded Commands in Order** are also unaffected by Motor Control Timeline enable states.

The send log displays the time, source, position, step count, CAN ID, eight-byte payload, and result. **ACK OK** means only that the action has entered the node queue; it does not mean that the motor has reached its target. Before batch replay or returning to the origin, the terminal checks that the relevant nodes' Status D FIFOs are empty.

## Returning to the Origin

The current positions at the moment CAN is connected define the origin for that session. Action Editor accumulates all acknowledged individual sends, resends, and batch motions and generates reverse compensation from the net step count for each physical CAN node. Compensation beyond the single-frame limit is split automatically. If multiple interface positions use the same ID, return compensation first combines their net steps by physical CAN node instead of compensating each position alias separately.

This **origin** is a command-step ledger maintained by the GUI from acknowledged commands; it is not a sensor-defined physical zero. Selecting closed-loop mode does not automatically turn it into an absolute encoder zero. After lost steps, external movement, or mechanical slipping, the ledger alone cannot guarantee a return to the true position. Any of the following immediately invalidates the local origin:

- STOP, DISABLE, or all-bus emergency stop;
- CAN disconnection or a bridge failure;
- a node-reported fault;
- changing the binding between a position and a node ID.

After confirming that the mechanism is safe, click **Set Current Position as Origin**. Action Editor first verifies that the FIFOs of all configured nodes are empty. If returning some motors fails, successfully compensated motors are deducted from the ledger; a later return compensates only the motors that have not yet reached zero.

**Return to Origin** is not affected by Motor Control Timeline enable states. Stop, hardware disable, and all-bus emergency stop are always available as well.

## Development and Verification

```bash
npm ci
npm run verify
npm start
```

`npm ci` installs the project's own Electron according to `package-lock.json`, and permits only the download script of the exactly pinned Electron package to run. `npm run verify` checks all JavaScript, the Python bridge, and the Shell scripts, then runs the complete regression suite for models, interface contracts, IPC security, import/export, bridge retry behavior, and local simulation.

Continuous integration is defined in `.github/workflows/ci.yml` and uses only the simulation bridge; it never accesses real CAN hardware. Dependabot checks for dependency updates monthly. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process and [SECURITY.md](SECURITY.md) for reporting security issues.

## License

This project is open source under the [Apache License 2.0](LICENSE). Copyright is owned by 鹏睿机器人（深圳）有限公司. See [NOTICE](NOTICE) for attribution and notice information. Use, modification, and distribution must comply with the copyright, license-notice, and NOTICE-retention requirements in the license. Apache License 2.0 also includes an explicit patent license. The software is provided “as is”; the license does not replace the emergency stop, travel limits, power isolation, or on-site safety measures required by the [Hardware Safety Guide](SAFETY.md).

## Safety Notes

- Only one GUI that writes commands to `can0` may run at a time. Exit other LumDriver control applications before starting Action Editor; otherwise, separate processes will allocate sequences independently and cause command contention.
- The top-bar emergency stop broadcasts immediate STOP + DISABLE. A normal application exit performs the same protective shutdown.
- Commands for multiple nodes at the same time point are requested concurrently by the host, but CAN remains a serial link and the current protocol has no multi-node hardware synchronization trigger.
- The software cannot replace a hardware emergency stop, power isolation, mechanical travel limits, current protection, or initial low-speed, short-travel testing.
