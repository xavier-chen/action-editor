#!/usr/bin/env python3
"""Bridge fixture that drops selected motion ACKs and accepts exact replays."""

import json
import sys
import time


motion_sequence = 7
control_sequence = 80
next_replay_id = 100
replays = {}


def write(message):
    print(json.dumps(message), flush=True)


def emit_ack(node_id, command_class, opcode, sequence, status=0, value=1):
    write({
        "type": "event",
        "event": "ack",
        "data": {
            "nodeId": node_id,
            "commandClass": command_class,
            "opcode": opcode,
            "sequence": sequence,
            "status": status,
            "statusName": "成功" if status == 0 else "拒绝",
            "ok": status == 0,
            "value": value,
            "timestamp": time.time(),
        },
    })


for line in sys.stdin:
    request = json.loads(line)
    action = request.get("action")
    request_id = request["id"]
    params = request.get("params", {})

    if action == "shutdown":
        write({
            "type": "response",
            "id": request_id,
            "ok": True,
            "result": {},
        })
        break

    if action in ("move", "servo_move"):
        node_id = params.get("nodeId", 17)
        sequence = motion_sequence
        motion_sequence = (motion_sequence + 1) & 0xFF
        replay_id = next_replay_id
        next_replay_id += 1
        replays[replay_id] = {
            "sequence": sequence,
            "nodeId": node_id,
            "commandClass": (
                2
                if action == "servo_move" or params.get("closed") is True
                else 1
            ),
            "dropForever": (
                params.get("count") == 999
                or params.get("angle") == 359
            ),
            "attempts": 0,
        }
        write({
            "type": "response",
            "id": request_id,
            "ok": True,
            "result": {
                "sequence": sequence,
                "speedLevel": params.get("speedLevel"),
                "accelerationLevel": params.get("accelerationLevel"),
                **(
                    {"angle": params.get("angle")}
                    if action == "servo_move"
                    else {}
                ),
                "replayId": replay_id,
                "nodeId": node_id,
            },
        })
        continue

    if action == "motion_replay":
        replay_id = params.get("replayId")
        record = replays.get(replay_id)
        if record is None:
            write({
                "type": "response",
                "id": request_id,
                "ok": False,
                "error": "unknown replay",
            })
            continue
        record["attempts"] += 1
        if not record["dropForever"]:
            emit_ack(
                record["nodeId"],
                record["commandClass"],
                0,
                record["sequence"],
            )
        write({
            "type": "response",
            "id": request_id,
            "ok": True,
            "result": {
                "sequence": record["sequence"],
                "replayId": replay_id,
                "nodeId": record["nodeId"],
                "replayed": True,
            },
        })
        continue

    if action in ("stop", "disable", "clear_faults"):
        broadcast = (
            action != "clear_faults"
            and params.get("broadcast") is True
        )
        node_id = 0 if broadcast else params.get("nodeId", 17)
        sequence = control_sequence
        control_sequence = (control_sequence + 1) & 0xFF
        opcode = {
            "stop": 2,
            "disable": 3,
            "clear_faults": 4,
        }[action]
        if not broadcast:
            emit_ack(node_id, 3, opcode, sequence, value=0)
        write({
            "type": "response",
            "id": request_id,
            "ok": True,
            "result": {
                "sequence": sequence,
                "broadcast": broadcast,
                "nodeId": node_id,
            },
        })
        continue

    write({
        "type": "response",
        "id": request_id,
        "ok": False,
        "error": "unsupported action",
    })
