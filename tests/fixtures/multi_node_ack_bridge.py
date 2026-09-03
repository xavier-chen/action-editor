#!/usr/bin/env python3
"""Fixture for node-aware ACK matching and ACK-free batch status."""

import json
import sys
import time


default_node = 17
session_epoch = 0


def write(message):
    print(json.dumps(message), flush=True)


def response(request_id, result):
    write({
        "type": "response",
        "id": request_id,
        "ok": True,
        "result": result,
    })


def ack(node_id, sequence, epoch):
    write({
        "type": "event",
        "event": "ack",
        "data": {
            "nodeId": node_id,
            "commandClass": 3,
            "opcode": 1,
            "sequence": sequence,
            "status": 0,
            "statusName": "成功",
            "ok": True,
            "value": 0,
            "timestamp": time.time(),
            "sessionEpoch": epoch,
        },
    })


for line in sys.stdin:
    request = json.loads(line)
    action = request.get("action")
    request_id = request["id"]
    params = request.get("params", {})

    if action == "shutdown":
        response(request_id, {})
        break

    if action == "connect":
        default_node = params.get("nodeId", 17)
        session_epoch = params.get("sessionEpoch", session_epoch + 1)
        response(request_id, {
            "connected": True,
            "nodeId": default_node,
            "simulate": True,
        })
        continue

    if action == "ping":
        node_id = params.get("nodeId", default_node)
        sequence = params.get("testSequence", 7)
        if params.get("emitAck", True):
            ack(
                params.get("ackNodeId", node_id),
                sequence,
                params.get("ackSessionEpoch", session_epoch),
            )
        response(request_id, {
            "sequence": sequence,
            "broadcast": False,
            "nodeId": node_id,
        })
        continue

    if action == "status_many":
        response(request_id, {
            "nodeIds": params.get("nodeIds", []),
            "flags": params.get("flags", 15),
        })
        continue

    response(request_id, {})
