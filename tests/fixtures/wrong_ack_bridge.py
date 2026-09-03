#!/usr/bin/env python3
"""Test bridge that returns the wrong device ACK sequence."""

import json
import sys
import time


for line in sys.stdin:
    request = json.loads(line)
    if request.get("action") == "shutdown":
        break
    now = time.time()
    node_id = request.get("params", {}).get("nodeId", 17)
    print(json.dumps({
        "type": "event",
        "event": "ack",
        "data": {
            "nodeId": node_id,
            "commandClass": 3,
            "opcode": 1,
            "sequence": 99,
            "status": 0,
            "statusName": "成功",
            "ok": True,
            "value": 0,
            "timestamp": now,
        },
    }), flush=True)
    print(json.dumps({
        "type": "response",
        "id": request["id"],
        "ok": True,
        "result": {
            "sequence": 1,
            "broadcast": False,
            "nodeId": node_id,
        },
    }), flush=True)
