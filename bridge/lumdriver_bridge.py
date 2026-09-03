#!/usr/bin/env python3
"""LumDriver V3 JSON-lines bridge using only the Python standard library."""

from __future__ import annotations

import json
import binascii
import socket
import struct
import sys
import threading
import time
from typing import Any, Callable, Dict, List, Optional


FRAME = struct.Struct("=IB3x8s")
FILTER = struct.Struct("=II")
EFF_FLAG = 0x80000000
RTR_FLAG = 0x40000000
ERR_FLAG = 0x20000000
FLAG_MASK = EFF_FLAG | RTR_FLAG | ERR_FLAG
EXACT_FILTER_MASK = 0xC00007FF
# Match one V2 response group while leaving the low seven node-ID bits free.
NODE_GROUP_FILTER_MASK = 0xC0000780
SOL_CAN_RAW = getattr(socket, "SOL_CAN_RAW", 101)
CAN_RAW_FILTER = getattr(socket, "CAN_RAW_FILTER", 1)

ACK_BASE = 0x180
OPEN_BASE = 0x200
CLOSED_BASE = 0x280
CONTROL_BASE = 0x300
PARAM_BASE = 0x380
STATUS_E_BASE = 0x400
STATUS_A_BASE = 0x480
STATUS_B_BASE = 0x500
STATUS_C_BASE = 0x580
STATUS_D_BASE = 0x600
PAIR_REQUEST = 0x6E0
PAIR_RESPONSE = 0x6E1
FW_UPDATE_REQUEST_BASE = 0x700
FW_UPDATE_RESPONSE_BASE = 0x780

PING = 0x01
STOP = 0x02
DISABLE = 0x03
CLEAR_FAULTS = 0x04
GET_STATUS = 0x05
CAL_START = 0x06
CAL_ABORT = 0x07
POSITION_LOCK = 0x0B
POSITION_UNLOCK = 0x0C
HOMING_START = 0x0D

HARDWARE_MODELS = {
    1: "分离式驱动板",
    2: "42 步进电机驱动板",
    3: "20 步进电机驱动板",
}

PARAM_GET = 0x01
PARAM_SET = 0x02
PARAM_SAVE = 0x03
PARAM_DEFAULTS = 0x04

PARAM_ENCODER_MOUNT_MODE = 0x12
PARAM_GEAR_RATIO_NUM = 0x13
PARAM_GEAR_RATIO_DEN = 0x14
ENCODER_MOUNT_MOTOR_SHAFT = 0
ENCODER_MOUNT_GEARBOX_OUTPUT = 1

PAIR_DISCOVER = 0x01
PAIR_ASSIGN = 0x02

FW_ENTER = 0x01
FW_QUERY = 0x02
FW_BEGIN_INFO = 0x10
FW_BEGIN_CRC = 0x11
FW_WINDOW_OPEN = 0x20
FW_WINDOW_END = 0x21
FW_FINALIZE = 0x30
FW_STATUS = 0x31
FW_ACTIVATE = 0x32
FW_ABORT = 0x33
FW_GENERIC_RESPONSE = 0x06
FW_WINDOW_RESPONSE = 0xE1
FW_ACTIVATE_COOKIE = 0x334D554C
# V3.1 keeps the physical A/B stride at 108 KiB, but the final 8 KiB of
# each region is a persistent LumScript bank.  The resident bootloader may
# update only the leading 100 KiB application area.
FW_SLOT_BYTES = 100 * 1024
SCRIPT_RESPONSE = 0x53
SCRIPT_QUERY = 0x40
SCRIPT_BEGIN = 0x41
SCRIPT_DATA = 0x42
SCRIPT_WINDOW_END = 0x43
SCRIPT_COMMIT = 0x44
SCRIPT_CONTROL = 0x45
SCRIPT_AUTH = 0x46
TEACH_RESPONSE = 0x54
TEACH_QUERY = 0x50
TEACH_BEGIN = 0x51
TEACH_DATA = 0x52
TEACH_WINDOW_END = 0x53
TEACH_COMMIT = 0x54
TEACH_READ = 0x55
TEACH_CONTROL = 0x56
TEACH_AUTH = 0x57
TEACH_ABI_VERSION = 1
TEACH_RECORD_BYTES = 14
TEACH_MAX_POINTS = 256
TEACH_MAX_PAYLOAD_BYTES = TEACH_RECORD_BYTES * TEACH_MAX_POINTS
TEACH_REPEAT_INFINITE = 0xFFFFFFFF
TEACH_CONTROL_FLAG_OPEN_LOOP = 1 << 0
TEACH_SUMMARY_OPEN_LOOP_SUPPORTED = 1 << 3
TEACH_PROGRAM_FLAG_HOMED_ABSOLUTE = 1 << 0
TEACH_PROGRAM_FLAG_RUNTIME_OPEN_LOOP = 1 << 1

MOTION_FORMAT = 6
MOTION_HEADER = 0xA0 | (MOTION_FORMAT << 1)
MOTION_TRAILER = 0xC5
MOTION_LEVEL_MIN = 1
MOTION_ACCELERATION_LEVEL_MIN = 0
MOTION_LEVEL_MAX = 100
SERVO_ANGLE_MIN = 0
SERVO_ANGLE_MAX = 359
SERVO_HEADER = 0xAA
SERVO_TRAILER = 0xFF
SPEED_LEVEL_100_RPM = 3_000
ACCELERATION_LEVEL_100_RPM_PER_S = 20_000
DYNAMIC_LIMIT_NUMERATOR = 4
DYNAMIC_LIMIT_DENOMINATOR = 5
LEVEL_SQUARE_DENOMINATOR = MOTION_LEVEL_MAX * MOTION_LEVEL_MAX
DUPLICATE_WINDOW_S = 2.0
# Leave transport and scheduling margin before the MCU's 2 s duplicate window
# closes.  Every retry below reuses the exact same CAN identifier and payload.
MOTION_REPLAY_WINDOW_S = 1.8
# Parameter requests wait up to 5 s in the Electron layer.  Expire correlation
# records shortly afterwards and well before the 8-bit control sequence can
# normally wrap under the 50 ms status poller.
PARAMETER_PENDING_TTL_S = 6.0
STATUS_MANY_MAX_NODES = 16
STATUS_A = 0x01
STATUS_B = 0x02
STATUS_C = 0x04
STATUS_D = 0x08
STATUS_E = 0x10
STATUS_ALL = STATUS_A | STATUS_B | STATUS_C | STATUS_D | STATUS_E
LIMIT_SWITCH_COUNT = 4
LIMIT_SWITCH_MASK = (1 << LIMIT_SWITCH_COUNT) - 1
LIMIT_STATUS_FORMAT_LEGACY = 1
LIMIT_STATUS_FORMAT = 2
SIM_HOMING_MAX_POLLS = 100
SIM_HOMING_ENCODER_CAPTURE_POLLS = 2

ACK_NAMES = {
    0: "成功",
    1: "CAN ID 错误",
    2: "帧长度错误",
    3: "未知指令",
    4: "载荷错误",
    5: "参数超范围",
    6: "当前状态不允许",
    7: "重复请求",
    8: "设备忙",
    9: "设备故障",
    10: "保存失败",
}

RUN_NAMES = {
    0: "启动安全",
    1: "自检",
    2: "已禁用",
    3: "开环运动",
    4: "闭环捕获",
    5: "闭环运动",
    6: "保持",
    7: "受控停止",
    8: "编码器校验",
    9: "配对",
    10: "故障锁存",
    11: "限位归零",
}

HOMING_NAMES = {
    0: "空闲",
    1: "寻找限位",
    2: "归零成功",
    3: "保护行程耗尽",
    4: "已中止",
}

CAL_NAMES = {
    0: "空闲",
    1: "预检查",
    2: "零位对齐",
    3: "零位稳定",
    4: "正向扫描",
    5: "正向稳定",
    6: "反向扫描",
    7: "反向稳定",
    8: "计算",
    9: "复核",
    10: "等待保存",
    11: "就绪",
    12: "失败",
}

FAULT_NAMES = {
    0: "急停",
    1: "配置错误",
    2: "编码器无磁场",
    3: "编码器奇偶校验",
    4: "编码器超时",
    5: "编码器超速",
    6: "编码器未校验",
    9: "CAN 发送错误",
    10: "CAN Bus-Off",
    11: "控制周期超时",
    12: "电机 ISR 超时",
    13: "Flash 错误",
    14: "固件断言",
}


class RequestValidationError(ValueError):
    """A request rejected before any CAN frame could have been sent."""


def bounded_int(name: str, value: Any, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("{}必须是整数".format(name))
    if value < low or value > high:
        raise ValueError("{}必须在{}–{}范围内".format(name, low, high))
    return value


def boolean(name: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValueError("{}必须是布尔值".format(name))
    return value


def frame(can_id: int, data: bytes) -> Dict[str, Any]:
    if not 0 <= can_id <= 0x7FF or len(data) != 8:
        raise ValueError("非法 CAN 帧")
    return {"id": can_id, "data": bytes(data), "timestamp": time.time()}


def frame_json(item: Dict[str, Any], direction: str) -> Dict[str, Any]:
    payload = item["data"]
    can_id = int(item["id"])
    base = can_id & ~0x7F
    node_id = (
        can_id & 0x7F
        if can_id not in (PAIR_REQUEST, PAIR_RESPONSE)
        and base in (
            ACK_BASE,
            OPEN_BASE,
            CLOSED_BASE,
            CONTROL_BASE,
            PARAM_BASE,
            STATUS_E_BASE,
            STATUS_A_BASE,
            STATUS_B_BASE,
            STATUS_C_BASE,
            STATUS_D_BASE,
            FW_UPDATE_REQUEST_BASE,
            FW_UPDATE_RESPONSE_BASE,
        )
        else None
    )
    return {
        "direction": direction,
        "arbitrationId": can_id,
        "idHex": "0x{:03X}".format(can_id),
        "nodeId": node_id,
        "data": list(payload),
        "dataHex": " ".join("{:02X}".format(byte) for byte in payload),
        "timestamp": item.get("timestamp", time.time()),
    }


def i32_bytes(value: int) -> bytes:
    value = max(-0x80000000, min(0x7FFFFFFF, int(value)))
    return struct.pack("<i", value)


def fnv1a32(data: bytes) -> int:
    value = 0x811C9DC5
    for byte in data:
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return value


def crc16_ccitt(data: bytes) -> int:
    value = 0xFFFF
    for byte in data:
        value ^= byte << 8
        for _ in range(8):
            value = ((value << 1) ^ 0x1021) & 0xFFFF \
                if value & 0x8000 else (value << 1) & 0xFFFF
    return value


def ack_frame(node: int, command_class: int, opcode: int, sequence: int,
              status: int, value: int = 0) -> Dict[str, Any]:
    data = bytes((command_class, opcode, sequence, status)) + i32_bytes(value)
    return frame(ACK_BASE | node, data)


def pair_response_frame(opcode: int, sequence: int, uid_hash: int,
                        node: int, status: int) -> Dict[str, Any]:
    data = bytes((opcode | 0x80, sequence))
    data += struct.pack("<I", uid_hash)
    data += bytes((node, status))
    return frame(PAIR_RESPONSE, data)


class SocketCanTransport:
    def __init__(self, callback: Callable[[Dict[str, Any]], None],
                 error_callback: Callable[..., None]) -> None:
        self.callback = callback
        self.error_callback = error_callback
        self.sock: Optional[socket.socket] = None
        self.thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.send_lock = threading.Lock()
        self.node = 0

    def connect(self, interface: str, node: int) -> None:
        self.close()
        sock = socket.socket(socket.AF_CAN, socket.SOCK_RAW,
                             getattr(socket, "CAN_RAW", 1))
        sock.settimeout(0.2)
        self._apply_filters(sock, node)
        sock.bind((interface,))
        with self.lock:
            self.node = node
            self.sock = sock
            self.stop_event.clear()
            self.thread = threading.Thread(
                target=self._receive_loop,
                name="electron-v2-can-rx",
                daemon=True,
            )
            self.thread.start()

    def set_node(self, node: int) -> None:
        with self.lock:
            self.node = node

    def send(self, item: Dict[str, Any]) -> None:
        packet = FRAME.pack(item["id"], 8, item["data"])
        with self.send_lock:
            with self.lock:
                sock = self.sock
            if sock is None:
                raise RuntimeError("SocketCAN 尚未连接")
            sent = sock.send(packet)
        if sent != FRAME.size:
            raise RuntimeError("SocketCAN 短写")

    def close(self) -> None:
        with self.lock:
            sock = self.sock
            thread = self.thread
            self.sock = None
            self.thread = None
            self.stop_event.set()
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    @staticmethod
    def _apply_filters(sock: socket.socket, _node: int) -> None:
        # A single SocketCAN socket serves the whole bus.  Filtering by the
        # UI's currently selected node loses ACK/status frames for concurrent
        # requests to other motors, so subscribe to every V2 response group.
        raw = b"".join(
            FILTER.pack(can_id, NODE_GROUP_FILTER_MASK)
            for can_id in (
                ACK_BASE,
                STATUS_E_BASE,
                STATUS_A_BASE,
                STATUS_B_BASE,
                STATUS_C_BASE,
                STATUS_D_BASE,
                FW_UPDATE_RESPONSE_BASE,
            )
        )
        raw += FILTER.pack(PAIR_RESPONSE, EXACT_FILTER_MASK)
        sock.setsockopt(SOL_CAN_RAW, CAN_RAW_FILTER, raw)

    def _receive_loop(self) -> None:
        while not self.stop_event.is_set():
            with self.lock:
                sock = self.sock
            if sock is None:
                return
            try:
                raw = sock.recv(FRAME.size)
            except socket.timeout:
                continue
            except OSError as exc:
                if not self.stop_event.is_set():
                    self.error_callback(
                        "SocketCAN 接收失败: {}".format(exc),
                        True,
                        self,
                    )
                return
            if len(raw) != FRAME.size:
                self.error_callback("收到错误长度的 SocketCAN 结构")
                continue
            can_id, dlc, data = FRAME.unpack(raw)
            if can_id & FLAG_MASK or can_id > 0x7FF or dlc != 8:
                self.error_callback("已丢弃非 V2 标准 8 字节数据帧")
                continue
            self.callback(frame(can_id, data))


def default_parameters(node: int) -> Dict[int, int]:
    return {
        0x01: node, 0x02: 1_000_000, 0x10: 200, 0x11: 128,
        0x12: 0, 0x13: 1, 0x14: 1,
        0x20: 500, 0x21: 200, 0x22: 800, 0x23: 100,
        0x24: 10_000, 0x25: 3300, 0x26: 2450,
        0x27: 1000, 0x28: 1000, 0x29: 0, 0x2A: 0,
        0x30: 10, 0x31: 10, 0x32: 10, 0x33: 0,
        0x40: 2000, 0x41: 500,
        0x44: 50, 0x47: 5, 0x48: 0,
        0x49: 3000, 0x4A: 20000,
        0x4B: 1, 0x4C: 1, 0x4D: 10,
    }


def parameters_valid(values: Dict[int, int]) -> bool:
    microsteps = values[0x11]
    return (
        values[0x02] in (125_000, 250_000, 500_000, 1_000_000)
        and 4 <= values[0x10] <= 2000 and values[0x10] % 4 == 0
        and microsteps in (1, 2, 4, 8, 16, 32, 64, 128, 256)
        and values[0x12] in (
            ENCODER_MOUNT_MOTOR_SHAFT,
            ENCODER_MOUNT_GEARBOX_OUTPUT,
        )
        and 1 <= values[0x13] <= 1000
        and 1 <= values[0x14] <= 1000
        and values[0x13] >= values[0x14]
        and 1 <= values[0x22] <= 2450
        and 0 <= values[0x20] <= values[0x22]
        and 0 <= values[0x21] <= values[0x22]
        and 50 <= values[0x23] <= 2000
        and 1000 <= values[0x24] <= 30000
        and 1800 <= values[0x25] <= 3600
        and 100 <= values[0x26] <= values[0x25]
        and 500 <= values[0x27] <= 2000
        and 500 <= values[0x28] <= 2000
        and values[0x29] in (0, 1) and values[0x2A] in (0, 1)
        and 0 <= values[0x30] <= 2000
        and 1 <= values[0x31] <= 1000
        and 1 <= values[0x32] <= 1000
        and values[0x33] in (0, 1, 2)
        and 0 <= values[0x40] <= 10000
        and 0 <= values[0x41] <= 10000
        and 1 <= values[0x44] <= 4096
        and 1 <= values[0x47] <= 1000
        and 0 <= values[0x48] <= 60000
        and 1 <= values[0x49] <= 5000
        and 1 <= values[0x4A] <= 20000
        and 1 <= values[0x4B] <= 4
        and values[0x4C] in (0, 1)
        and 1 <= values[0x4D] <= 100
    )


class SimulatedTransport:
    UID = 0x4C554D32

    def __init__(self, callback: Callable[[Dict[str, Any]], None],
                 error_callback: Callable[..., None]) -> None:
        self.callback = callback
        self.error_callback = error_callback
        self.connected = False
        self.node = 0
        self.filter_node = 0
        self.parameters: Dict[int, int] = {}
        self.saved: Dict[int, int] = {}
        self.position = 0
        self.target = 0
        self.last_motion_sequence = 0
        self.faults = 0
        self.encoder_valid = True
        self.calibration_valid = False
        self.calibration_state = 0
        self.run_state = 2
        self.closed = False
        self.position_lock_active = False
        self.current_ma = 0
        # The simulator identifies as the separate driver board, which has
        # two active-low limit inputs.  Tests may alter active_mask to model a
        # switch closing without inventing a simulator-only command.
        self.limit_switch_present_mask = 0x03
        self.limit_switch_active_mask = 0x00
        self.homing_state = 0
        self.homing_polls = 0
        self.homing_encoder_capture_polls = 0
        self.pair_window = False
        self.last_speed_level = 0
        self.last_acceleration_level = 0
        self.last_actual_speed = 0
        self.last_actual_acceleration = 0
        self.motion_capacity = 64
        self.motion_queue: List[Dict[str, Any]] = []
        self.motion_ack_cache: Dict[
            tuple[int, bytes], tuple[int, int, float]
        ] = {}
        self.update_boot = False
        self.update_challenge: Optional[tuple[int, float]] = None
        self.update_transfer: Optional[Dict[str, Any]] = None
        self.update_window: Optional[Dict[str, Any]] = None
        self.update_active_slot = 0
        self.update_authorized = False
        self.update_trial_pending = False
        self.update_trial_observations = 0
        self.script_image = b""
        self.script_crc32 = 0
        self.script_generation = 0
        self.script_bank = 0
        self.script_active = False
        self.script_paused = False
        self.script_authorized_until = 0.0
        self.script_staging: Optional[Dict[str, Any]] = None
        self.teach_payload = b""
        self.teach_crc32 = 0
        self.teach_generation = 0
        self.teach_bank = 0
        self.teach_coordinate_mode = 0
        self.teach_runtime_state = 0
        self.teach_active_point: Optional[int] = None
        self.teach_completed_repeats = 0
        self.teach_requested_repeats = 0
        self.teach_run_mode_open = False
        self.teach_last_error = 0
        self.teach_authorized_until = 0.0
        self.teach_staging: Optional[Dict[str, Any]] = None
        self.teach_capture_position = 0

    def connect(self, _interface: str, node: int) -> None:
        self.node = node
        self.filter_node = node
        self.parameters = default_parameters(node)
        self.saved = dict(self.parameters)
        self.motion_queue.clear()
        self.motion_ack_cache.clear()
        self.position = 0
        self.target = 0
        self.closed = False
        self.position_lock_active = False
        self.current_ma = 0
        self.run_state = 2
        self.homing_state = 0
        self.homing_polls = 0
        self.homing_encoder_capture_polls = 0
        self.connected = True
        self.update_boot = False
        self.update_challenge = None
        self.update_transfer = None
        self.update_window = None
        self.update_authorized = False
        self.update_trial_pending = False
        self.update_trial_observations = 0
        self.script_staging = None
        self.script_authorized_until = 0.0
        self.teach_staging = None
        self.teach_authorized_until = 0.0
        self.teach_runtime_state = 0
        self.teach_active_point = None
        self.teach_completed_repeats = 0
        self.teach_requested_repeats = 0
        self.teach_run_mode_open = False

    def set_node(self, node: int) -> None:
        self.filter_node = node

    def close(self) -> None:
        self.connected = False

    def open_pair_window(self) -> None:
        self.pair_window = True
        self.run_state = 9

    def send(self, item: Dict[str, Any]) -> None:
        if not self.connected:
            raise RuntimeError("仿真器尚未连接")
        responses = self._process(item)
        for response in responses:
            # Mirror the real SocketCAN transport's bus-wide response
            # subscription.  filter_node is retained only as legacy default
            # selection state; it must not suppress explicitly addressed
            # requests to another managed node.
            self.callback(response)

    def _process(self, item: Dict[str, Any]) -> List[Dict[str, Any]]:
        can_id = item["id"]
        data = item["data"]
        if can_id == PAIR_REQUEST:
            return self._pair(data)
        if (
            self.node != 0
            and can_id == (FW_UPDATE_REQUEST_BASE | self.node)
        ):
            return self._firmware_update(data)
        if can_id == CONTROL_BASE:
            if data[0] in (STOP, DISABLE, CAL_ABORT):
                self._control(data, broadcast=True)
            return []
        if self.node == 0:
            return []
        if can_id == (CONTROL_BASE | self.node):
            return self._control(data, broadcast=False)
        if can_id == (PARAM_BASE | self.node):
            return self._parameter(data)
        if can_id in (OPEN_BASE | self.node, CLOSED_BASE | self.node):
            return self._motion(data, can_id >= CLOSED_BASE)
        return []

    def _firmware_response(self, opcode: int, sequence: int,
                           status: int = 0, value: int = 0) -> Dict[str, Any]:
        payload = bytes((FW_GENERIC_RESPONSE, opcode, sequence, status))
        payload += struct.pack("<I", value & 0xFFFFFFFF)
        return frame(FW_UPDATE_RESPONSE_BASE | self.node, payload)

    def _firmware_update(self, data: bytes) -> List[Dict[str, Any]]:
        opcode = data[0]
        sequence = data[1]
        if SCRIPT_QUERY <= opcode <= SCRIPT_AUTH:
            return self._script_update(data)
        if TEACH_QUERY <= opcode <= TEACH_AUTH:
            return self._teach_update(data)
        if opcode == FW_QUERY:
            selector = data[2]
            argument = struct.unpack("<I", data[4:8])[0]
            if data[3] != 0:
                return [self._firmware_response(opcode, sequence, 2)]
            if selector == 5:
                if argument == 0:
                    return [self._firmware_response(opcode, sequence, 2)]
                self.update_challenge = (argument, time.monotonic() + 5.0)
                return [self._firmware_response(
                    opcode, sequence, 0, self.UID ^ argument
                )]
            if not self.update_boot:
                values = {
                    0: (9 << 24) | (3 << 16) | 0xFFFF,
                    1: self.update_active_slot
                        | (0x100 if self.update_trial_pending else 0),
                }
                if selector == 1 and self.update_trial_pending:
                    self.update_trial_observations += 1
                    if self.update_trial_observations >= 1:
                        # Return the pending sample once, then model the
                        # health-confirm reset before the next query.
                        value = values[selector]
                        self.update_trial_pending = False
                        return [self._firmware_response(
                            opcode, sequence, 0, value
                        )]
                if selector not in values:
                    return [self._firmware_response(
                        opcode, sequence, 3
                    )]
                return [self._firmware_response(
                    opcode, sequence, 0, values[selector]
                )]
            pending = 0xFF
            values = {
                0: (7 << 24) | (1 << 16)
                    | (self.update_active_slot << 8) | pending,
                1: self.update_active_slot,
                2: 1 - self.update_active_slot,
                3: (
                    int(self.update_transfer["length"])
                    if self.update_transfer
                    and self.update_transfer.get("finalized", False)
                    else int(self.update_transfer.get("durable", 0))
                    if self.update_transfer else 0
                ),
                4: 32,
                6: 0x08023000 if self.update_active_slot == 0
                    else 0x08008000,
                7: FW_SLOT_BYTES,
                8: (
                    ((2 if self.update_transfer.get("finalized", False)
                      else 1) << 24)
                    | int(self.update_transfer.get("id", 0))
                    if self.update_transfer else 0
                ),
            }
            if selector not in values:
                return [self._firmware_response(opcode, sequence, 4)]
            return [self._firmware_response(
                opcode, sequence, 0, values[selector]
            )]
        if opcode == FW_ENTER:
            token = struct.unpack("<I", data[4:8])[0]
            challenge = self.update_challenge
            if data[2] != 0 or data[3] != 0 or challenge is None:
                return [self._firmware_response(opcode, sequence, 8)]
            nonce, expires_at = challenge
            expected = fnv1a32(
                struct.pack("<II", self.UID, nonce) + b"LUM3"
            )
            if time.monotonic() > expires_at or token != expected:
                return [self._firmware_response(opcode, sequence, 8)]
            self._clear_motion_queue()
            was_boot = self.update_boot
            self.update_boot = True
            self.update_authorized = was_boot
            self.update_challenge = None
            return [self._firmware_response(opcode, sequence, 0, token)]
        if not self.update_boot:
            return [self._firmware_response(opcode, sequence, 3)]
        if opcode not in (FW_QUERY, FW_ENTER) and not self.update_authorized:
            return [self._firmware_response(opcode, sequence, 8)]
        if opcode == FW_BEGIN_INFO:
            transfer_id = int.from_bytes(data[2:4], "little")
            length = int.from_bytes(data[4:7], "little")
            slot = data[7] & 1
            if transfer_id == 0 or length == 0 or length > FW_SLOT_BYTES \
                    or data[7] & 0xFE or slot == self.update_active_slot:
                return [self._firmware_response(opcode, sequence, 4)]
            existing = self.update_transfer
            if existing and (
                existing["id"] != transfer_id
                or existing["length"] != length
                or existing["slot"] != slot
            ):
                return [self._firmware_response(opcode, sequence, 3)]
            if existing is None:
                self.update_transfer = {
                    "id": transfer_id, "length": length, "slot": slot,
                    "crc": None, "image": bytearray(b"\xFF" * length),
                    "current": 0, "durable": 0, "finalized": False,
                }
            return [self._firmware_response(opcode, sequence)]
        if opcode == FW_BEGIN_CRC:
            transfer_id = int.from_bytes(data[2:4], "little")
            expected_crc = struct.unpack("<I", data[4:8])[0]
            transfer = self.update_transfer
            if not transfer or transfer["id"] != transfer_id:
                return [self._firmware_response(opcode, sequence, 3)]
            if transfer["crc"] not in (None, expected_crc):
                return [self._firmware_response(opcode, sequence, 3)]
            transfer["crc"] = expected_crc
            return [self._firmware_response(
                opcode, sequence, 0, int(transfer.get("current", 0))
            )]
        if opcode == FW_WINDOW_OPEN:
            token = int.from_bytes(data[1:3], "little")
            offset = int.from_bytes(data[3:6], "little")
            count, last_length = data[6], data[7]
            transfer = self.update_transfer
            length = (count - 1) * 6 + last_length if count else 0
            if (
                not transfer or transfer["crc"] is None
                or not 1 <= token <= 1023 or not 1 <= count <= 32
                or not 1 <= last_length <= 6
                or offset != int(transfer.get("current", 0))
                or offset + length > transfer["length"]
                or offset // 2048 != (offset + length - 1) // 2048
            ):
                return [self._firmware_response(
                    opcode, token & 0xFF, 4,
                    int(transfer.get("current", 0)) if transfer else 0,
                )]
            self.update_window = {
                "token": token, "offset": offset, "count": count,
                "lastLength": last_length, "slots": {},
            }
            return [self._firmware_response(
                opcode, token & 0xFF, 0, offset
            )]
        if opcode & 0x80:
            window = self.update_window
            if window is None:
                return []
            token = ((opcode >> 5) & 3) << 8 | data[1]
            slot = opcode & 0x1F
            if token == window["token"] and slot < window["count"]:
                window["slots"][slot] = bytes(data[2:8])
            return []
        if opcode == FW_WINDOW_END:
            token = int.from_bytes(data[1:3], "little")
            offset = int.from_bytes(data[3:6], "little")
            expected_crc = int.from_bytes(data[6:8], "little")
            window = self.update_window
            status = 6
            bitmap = 0
            if window and token == window["token"] and offset == window["offset"]:
                for slot in window["slots"]:
                    bitmap |= 1 << slot
                full = (1 << window["count"]) - 1
                if bitmap != full:
                    status = 0
                else:
                    payload = b"".join(
                        window["slots"][slot]
                        for slot in range(window["count"])
                    )
                    valid_length = ((window["count"] - 1) * 6
                                    + window["lastLength"])
                    payload = payload[:valid_length]
                    if crc16_ccitt(payload) != expected_crc:
                        status = 4
                    else:
                        transfer = self.update_transfer
                        transfer["image"][offset:offset + valid_length] = payload
                        end = offset + valid_length
                        transfer["current"] = end
                        if end % 2048 == 0:
                            transfer["durable"] = end
                        status = 1
                        self.update_window = None
            response = bytes((FW_WINDOW_RESPONSE,))
            response += struct.pack("<HBI", token, status, bitmap)
            return [frame(FW_UPDATE_RESPONSE_BASE | self.node, response)]
        if opcode == FW_FINALIZE:
            transfer_id = int.from_bytes(data[2:4], "little")
            expected_crc = struct.unpack("<I", data[4:8])[0]
            transfer = self.update_transfer
            if not transfer or transfer["id"] != transfer_id:
                return [self._firmware_response(opcode, sequence, 3)]
            actual = binascii.crc32(transfer["image"]) & 0xFFFFFFFF
            if actual != expected_crc or actual != transfer["crc"]:
                return [self._firmware_response(opcode, sequence, 5)]
            transfer["finalized"] = True
            return [self._firmware_response(opcode, sequence)]
        if opcode == FW_STATUS:
            transfer = self.update_transfer
            transfer_id = int.from_bytes(data[2:4], "little")
            selector = data[4]
            if data[5:8] != b"\x00\x00\x00" or (
                transfer_id and (
                    not transfer or transfer_id != int(transfer["id"])
                )
            ):
                return [self._firmware_response(opcode, sequence, 2)]
            values = {
                0: (((2 if transfer.get("finalized", False) else 1) << 24)
                    | int(transfer["id"])) if transfer else 0,
                1: int(transfer.get("current", 0)) if transfer else 0,
                2: int(transfer.get("durable", 0)) if transfer else 0,
                3: int(transfer.get("length", 0)) if transfer else 0,
                4: int(transfer.get("crc", 0) or 0) if transfer else 0,
            }
            if selector not in values:
                return [self._firmware_response(opcode, sequence, 4)]
            value = values[selector]
            return [self._firmware_response(opcode, sequence, 0, value)]
        if opcode == FW_ACTIVATE:
            transfer_id = int.from_bytes(data[2:4], "little")
            cookie = struct.unpack("<I", data[4:8])[0]
            transfer = self.update_transfer
            if not transfer or transfer["id"] != transfer_id \
                    or not transfer["finalized"] or cookie != FW_ACTIVATE_COOKIE:
                return [self._firmware_response(opcode, sequence, 3)]
            self.update_active_slot = transfer["slot"]
            self.update_boot = False
            self.update_transfer = None
            self.update_trial_pending = True
            self.update_trial_observations = 0
            return [self._firmware_response(opcode, sequence)]
        if opcode == FW_ABORT:
            self.update_transfer = None
            self.update_window = None
            return [self._firmware_response(opcode, sequence)]
        return [self._firmware_response(opcode, sequence, 1)]

    def _script_response(self, opcode: int, sequence: int,
                         status: int = 0, value: int = 0) -> Dict[str, Any]:
        payload = bytes((SCRIPT_RESPONSE, opcode, sequence, status))
        payload += struct.pack("<I", value & 0xFFFFFFFF)
        return frame(FW_UPDATE_RESPONSE_BASE | self.node, payload)

    def _script_update(self, data: bytes) -> List[Dict[str, Any]]:
        opcode, sequence = data[0], data[1]
        authorized = time.monotonic() < self.script_authorized_until
        if opcode == SCRIPT_QUERY:
            selector = data[2]
            if data[3:8] != b"\x00\x00\x00\x00\x00":
                return [self._script_response(opcode, sequence, 2)]
            summary = ((1 << 16)
                       | (1 if self.script_image else 0)
                       | (2 if self.script_staging else 0)
                       | (4 if self.script_bank else 0))
            values = {
                0: summary, 1: len(self.script_image),
                2: self.script_crc32,
                3: int(self.script_staging.get("offset", 0))
                   if self.script_staging else 0,
                4: self.script_generation, 5: 0, 6: 0,
                7: 0, 8: 0,
            }
            if selector not in values:
                return [self._script_response(opcode, sequence, 4)]
            return [self._script_response(opcode, sequence, 0,
                                          values[selector])]
        if opcode == SCRIPT_AUTH:
            if data[2:4] != b"\x00\x00" or not self.update_challenge:
                return [self._script_response(opcode, sequence, 8)]
            nonce, expiry = self.update_challenge
            token_data = struct.pack("<II", self.UID, nonce) + b"LUM3"
            expected = 0x811C9DC5
            for byte in token_data:
                expected ^= byte
                expected = (expected * 0x01000193) & 0xFFFFFFFF
            supplied = struct.unpack("<I", data[4:8])[0]
            if time.monotonic() > expiry or supplied != expected:
                return [self._script_response(opcode, sequence, 8)]
            self.script_authorized_until = time.monotonic() + 30.0
            return [self._script_response(opcode, sequence, 0, 30000)]
        if opcode == SCRIPT_CONTROL:
            action, command_id = data[2], data[3]
            argument = struct.unpack("<i", data[4:8])[0]
            if action not in (1, 2, 3, 4, 5) \
                    or (action != 5 and (command_id or argument)):
                return [self._script_response(opcode, sequence, 2)]
            if action == 1:
                if not self.script_image:
                    return [self._script_response(opcode, sequence, 3)]
                self.script_active, self.script_paused = True, False
            elif action == 2:
                self.script_active, self.script_paused = False, False
                self._clear_motion_queue()
            elif action == 3:
                if not self.script_active:
                    return [self._script_response(opcode, sequence, 3)]
                self.script_paused = True
            elif action == 4:
                if not self.script_active:
                    return [self._script_response(opcode, sequence, 3)]
                self.script_paused = False
            elif not self.script_active or self.script_paused:
                return [self._script_response(opcode, sequence, 3)]
            return [self._script_response(opcode, sequence, 0, command_id)]
        if not authorized:
            return [self._script_response(opcode, sequence, 8)]
        if opcode == SCRIPT_BEGIN:
            length = int.from_bytes(data[2:4], "little")
            expected_crc = struct.unpack("<I", data[4:8])[0]
            if not 32 <= length <= 6144:
                return [self._script_response(opcode, sequence, 4)]
            token = 1
            if (not self.script_staging
                    or self.script_staging["length"] != length
                    or self.script_staging["crc"] != expected_crc):
                self.script_staging = {
                    "length": length, "crc": expected_crc,
                    "offset": 0, "token": token,
                    "image": bytearray(length), "frames": {},
                }
            staging = self.script_staging
            value = (int(staging["offset"]) << 16) \
                | ((self.script_bank ^ 1) << 8) | int(staging["token"])
            return [self._script_response(opcode, sequence, 0, value)]
        staging = self.script_staging
        if not staging:
            return [self._script_response(opcode, sequence, 3)]
        if opcode == SCRIPT_DATA:
            if data[1] != staging["token"] or data[2] >= 32:
                return []
            staging["frames"][data[2]] = bytes(data[3:8])
            return []
        if opcode == SCRIPT_WINDOW_END:
            token, count, last_length = data[2], data[3], data[4]
            expected_crc = int.from_bytes(data[5:7], "little")
            if data[7] or token != staging["token"] \
                    or not 1 <= count <= 32 or not 1 <= last_length <= 5:
                return [self._script_response(opcode, sequence, 2)]
            missing = sum(1 << index for index in range(count)
                          if index not in staging["frames"])
            if missing:
                return [self._script_response(opcode, sequence, 0, missing)]
            payload = b"".join(staging["frames"][index]
                               for index in range(count))
            payload = payload[:(count - 1) * 5 + last_length]
            if crc16_ccitt(payload) != expected_crc:
                return [self._script_response(opcode, sequence, 5)]
            end = staging["offset"] + len(payload)
            if end > staging["length"]:
                return [self._script_response(opcode, sequence, 4)]
            staging["image"][staging["offset"]:end] = payload
            staging["offset"] = end
            staging["frames"] = {}
            return [self._script_response(opcode, sequence, 0, 0)]
        if opcode == SCRIPT_COMMIT:
            expected_crc = struct.unpack("<I", data[4:8])[0]
            image = bytes(staging["image"])
            if data[2:4] != b"\x00\x00" \
                    or staging["offset"] != staging["length"] \
                    or expected_crc != staging["crc"] \
                    or (binascii.crc32(image) & 0xFFFFFFFF) != expected_crc:
                return [self._script_response(opcode, sequence, 5)]
            self.script_image = image
            self.script_crc32 = expected_crc
            self.script_bank ^= 1
            self.script_generation += 1
            self.script_active = False
            self.script_staging = None
            return [self._script_response(opcode, sequence, 0,
                                          self.script_generation)]
        return [self._script_response(opcode, sequence, 1)]

    def _teach_response(self, opcode: int, sequence: int,
                        status: int = 0, value: int = 0) -> Dict[str, Any]:
        payload = bytes((TEACH_RESPONSE, opcode, sequence, status))
        payload += struct.pack("<I", value & 0xFFFFFFFF)
        return frame(FW_UPDATE_RESPONSE_BASE | self.node, payload)

    def _teach_update(self, data: bytes) -> List[Dict[str, Any]]:
        opcode, sequence = data[0], data[1]
        authorized = time.monotonic() < self.teach_authorized_until

        if opcode == TEACH_QUERY:
            selector = data[2]
            if data[3:8] != b"\x00\x00\x00\x00\x00":
                return [self._teach_response(opcode, sequence, 2)]
            if selector == 10:
                self.teach_capture_position = int(self.position)
            installed = self.teach_generation > 0
            summary = ((TEACH_ABI_VERSION << 16)
                       | ((self.teach_runtime_state & 0xFF) << 8)
                       | (1 if installed else 0)
                       | (2 if self.teach_staging else 0)
                       | (4 if self.teach_bank else 0)
                       | TEACH_SUMMARY_OPEN_LOOP_SUPPORTED)
            captured = self.teach_capture_position & 0xFFFFFFFFFFFFFFFF
            values = {
                0: summary,
                1: len(self.teach_payload) if installed else 0,
                2: self.teach_crc32 if installed else 0,
                3: int(self.teach_staging.get("offset", 0))
                   if self.teach_staging else 0,
                4: self.teach_generation,
                5: len(self.teach_payload) // TEACH_RECORD_BYTES
                   if installed else 0,
                6: self.teach_active_point
                   if self.teach_active_point is not None else 0xFFFFFFFF,
                7: self.teach_completed_repeats,
                8: self.teach_requested_repeats,
                9: self.teach_last_error,
                10: captured & 0xFFFFFFFF,
                11: captured >> 32,
                12: (
                    (TEACH_PROGRAM_FLAG_HOMED_ABSOLUTE
                     if self.teach_coordinate_mode else 0)
                    | (TEACH_PROGRAM_FLAG_RUNTIME_OPEN_LOOP
                       if self.teach_run_mode_open else 0)
                ),
            }
            if selector not in values:
                return [self._teach_response(opcode, sequence, 4)]
            return [self._teach_response(
                opcode, sequence, 0, int(values[selector])
            )]

        if opcode == TEACH_AUTH:
            if data[2:4] != b"\x00\x00" or not self.update_challenge:
                return [self._teach_response(opcode, sequence, 8)]
            nonce, expiry = self.update_challenge
            expected = fnv1a32(
                struct.pack("<II", self.UID, nonce) + b"LUM3"
            )
            supplied = struct.unpack("<I", data[4:8])[0]
            if time.monotonic() > expiry or supplied != expected:
                return [self._teach_response(opcode, sequence, 8)]
            self.teach_authorized_until = time.monotonic() + 30.0
            return [self._teach_response(opcode, sequence, 0, 30000)]

        if opcode == TEACH_READ:
            offset = int.from_bytes(data[2:4], "little")
            length = data[4]
            if data[5:8] != b"\x00\x00\x00" or not 1 <= length <= 4:
                return [self._teach_response(opcode, sequence, 2)]
            if self.teach_generation == 0 or offset + length > len(
                self.teach_payload
            ):
                return [self._teach_response(opcode, sequence, 4)]
            raw = self.teach_payload[offset:offset + length]
            raw += b"\xFF" * (4 - length)
            return [self._teach_response(
                opcode, sequence, 0, struct.unpack("<I", raw)[0]
            )]

        if opcode == TEACH_CONTROL:
            action, flags = data[2], data[3]
            repeat_count = struct.unpack("<I", data[4:8])[0]
            if action not in (1, 2, 3, 4) or (
                action == 1 and flags & ~TEACH_CONTROL_FLAG_OPEN_LOOP
            ) or (action != 1 and flags != 0):
                return [self._teach_response(opcode, sequence, 2)]
            if action == 1:
                open_loop = bool(flags & TEACH_CONTROL_FLAG_OPEN_LOOP)
                if repeat_count == 0:
                    return [self._teach_response(opcode, sequence, 4)]
                if self.teach_generation == 0 or not self.teach_payload:
                    return [self._teach_response(opcode, sequence, 3)]
                if self.faults or self.homing_state == 1 or (
                    not open_loop and not (
                        self.encoder_valid and self.calibration_valid
                    )
                ):
                    return [self._teach_response(opcode, sequence, 3)]
                self._clear_motion_queue()
                self.teach_run_mode_open = open_loop
                self.closed = not open_loop
                self.teach_runtime_state = 1
                self.teach_active_point = 0
                self.teach_completed_repeats = 0
                self.teach_requested_repeats = repeat_count
            elif action == 2:
                if repeat_count != 0:
                    return [self._teach_response(opcode, sequence, 2)]
                self.teach_runtime_state = 0
                self.teach_active_point = None
                self._clear_motion_queue()
            elif action == 3:
                if repeat_count != 0:
                    return [self._teach_response(opcode, sequence, 2)]
                if self.teach_runtime_state != 1:
                    return [self._teach_response(opcode, sequence, 3)]
                self.teach_runtime_state = 2
            else:
                if repeat_count != 0:
                    return [self._teach_response(opcode, sequence, 2)]
                if self.teach_runtime_state != 2:
                    return [self._teach_response(opcode, sequence, 3)]
                self.teach_runtime_state = 1
            return [self._teach_response(
                opcode, sequence, 0,
                self.teach_active_point
                if self.teach_active_point is not None else 0xFFFFFFFF,
            )]

        if not authorized:
            return [self._teach_response(opcode, sequence, 8)]

        if opcode == TEACH_BEGIN:
            length_field = int.from_bytes(data[2:4], "little")
            coordinate_mode = 1 if length_field & 0x8000 else 0
            length = length_field & 0x7FFF
            expected_crc = struct.unpack("<I", data[4:8])[0]
            if (length > TEACH_MAX_PAYLOAD_BYTES
                    or length % TEACH_RECORD_BYTES):
                return [self._teach_response(opcode, sequence, 4)]
            token = 1
            if (not self.teach_staging
                    or self.teach_staging["length"] != length
                    or self.teach_staging["crc"] != expected_crc
                    or self.teach_staging["mode"] != coordinate_mode):
                self.teach_staging = {
                    "length": length,
                    "crc": expected_crc,
                    "mode": coordinate_mode,
                    "offset": 0,
                    "token": token,
                    "image": bytearray(length),
                    "frames": {},
                }
            staging = self.teach_staging
            value = ((int(staging["offset"]) & 0xFFFF) << 16) \
                | ((self.teach_bank ^ 1) << 8) | int(staging["token"])
            return [self._teach_response(opcode, sequence, 0, value)]

        staging = self.teach_staging
        if not staging:
            return [self._teach_response(opcode, sequence, 3)]
        if opcode == TEACH_DATA:
            if data[1] != staging["token"] or data[2] >= 32:
                return []
            staging["frames"][data[2]] = bytes(data[3:8])
            return []
        if opcode == TEACH_WINDOW_END:
            token, count, last_length = data[2], data[3], data[4]
            expected_crc = int.from_bytes(data[5:7], "little")
            if (data[7] or token != staging["token"]
                    or not 1 <= count <= 32
                    or not 1 <= last_length <= 5):
                return [self._teach_response(opcode, sequence, 2)]
            missing = sum(
                1 << index for index in range(count)
                if index not in staging["frames"]
            )
            if missing:
                return [self._teach_response(
                    opcode, sequence, 0, missing
                )]
            payload = b"".join(
                staging["frames"][index] for index in range(count)
            )
            payload = payload[:(count - 1) * 5 + last_length]
            if crc16_ccitt(payload) != expected_crc:
                return [self._teach_response(opcode, sequence, 5)]
            end = int(staging["offset"]) + len(payload)
            if end > int(staging["length"]):
                return [self._teach_response(opcode, sequence, 4)]
            staging["image"][staging["offset"]:end] = payload
            staging["offset"] = end
            staging["frames"] = {}
            return [self._teach_response(opcode, sequence, 0, 0)]
        if opcode == TEACH_COMMIT:
            expected_crc = struct.unpack("<I", data[4:8])[0]
            image = bytes(staging["image"])
            if (data[2:4] != b"\x00\x00"
                    or staging["offset"] != staging["length"]
                    or expected_crc != staging["crc"]
                    or (binascii.crc32(image) & 0xFFFFFFFF)
                    != expected_crc):
                return [self._teach_response(opcode, sequence, 5)]
            self.teach_payload = image
            self.teach_crc32 = expected_crc
            self.teach_coordinate_mode = int(staging["mode"])
            self.teach_bank ^= 1
            self.teach_generation += 1
            self.teach_staging = None
            self.teach_runtime_state = 0
            self.teach_active_point = None
            self.teach_completed_repeats = 0
            self.teach_requested_repeats = 0
            self.teach_run_mode_open = False
            self._clear_motion_queue()
            return [self._teach_response(
                opcode, sequence, 0, self.teach_generation
            )]
        return [self._teach_response(opcode, sequence, 1)]

    def _control(self, data: bytes, broadcast: bool) -> List[Dict[str, Any]]:
        opcode, sequence, flags = data[0], data[1], data[2]
        argument = struct.unpack("<I", data[4:8])[0]
        status = 0
        value = 0
        if opcode == PING:
            value = 0x01030201
        elif opcode == STOP:
            self._clear_motion_queue()
            self.teach_runtime_state = 0
            self.teach_active_point = None
            if self.homing_state == 1:
                self.homing_state = 4
                self.homing_encoder_capture_polls = 0
                self.run_state = 2
                self.current_ma = 0
        elif opcode == DISABLE:
            self._clear_motion_queue()
            self.teach_runtime_state = 0
            self.teach_active_point = None
            if self.homing_state == 1:
                self.homing_state = 4
                self.homing_encoder_capture_polls = 0
            self.run_state = 2
            self.current_ma = 0
        elif opcode == CLEAR_FAULTS:
            # A successful firmware CLEAR_FAULTS is also an actuator
            # cancellation boundary: it retires automation, clears FIFO and
            # forces the output off before acknowledging the cleared latch.
            self._clear_motion_queue()
            self.script_active = False
            self.script_paused = False
            self.teach_runtime_state = 0
            self.teach_active_point = None
            if self.homing_state == 1:
                self.homing_state = 4
                self.homing_encoder_capture_polls = 0
            self.faults &= ~argument if argument else 0
            value = self.faults
        elif opcode == GET_STATUS:
            self._advance_homing()
            responses: List[Dict[str, Any]] = []
            requested = flags or STATUS_ALL
            if requested & STATUS_A:
                responses.append(self._status_a())
            if requested & STATUS_B:
                responses.append(self._status_b())
            if requested & STATUS_C:
                responses.append(self._status_c())
            if requested & STATUS_D:
                responses.append(self._status_d())
            if requested & STATUS_E:
                responses.append(self._status_e())
            responses.append(ack_frame(self.node, 3, opcode, sequence, 0,
                                       self.faults))
            self._advance_motion()
            return [] if broadcast else responses
        elif opcode == CAL_START:
            if (
                self.position_lock_active
                or self.motion_queue
                or self.homing_state == 1
            ):
                status = 6
            elif not self.encoder_valid:
                self.faults |= 1 << 2
                status = 6
            else:
                self.calibration_state = 11
                self.calibration_valid = True
                self.position = 0
                self.target = 0
                self.run_state = 2
        elif opcode == CAL_ABORT:
            self.calibration_state = 0
            self.run_state = 2
        elif opcode == POSITION_LOCK:
            if flags != 0 or argument != 0:
                status = 4
            elif self.position_lock_active:
                value = self.target
            elif (
                self.faults
                or self.motion_queue
                or self.homing_state == 1
                or not self.encoder_valid
                or not self.calibration_valid
            ):
                status = 6
            elif self.parameters[0x21] == 0:
                status = 5
            else:
                self.position_lock_active = True
                self.closed = True
                self.target = self.position
                value = self.target
                self.run_state = 6
                self.current_ma = self.parameters[0x21]
        elif opcode == POSITION_UNLOCK:
            if flags != 0 or argument != 0:
                status = 4
            elif self.homing_state == 1:
                status = 8
            else:
                self.position_lock_active = False
                self.closed = False
                self.target = self.position
                self.run_state = 2
                self.current_ma = 0
        elif opcode == HOMING_START:
            limit_index = int(self.parameters[0x4B])
            limit_bit = 1 << (limit_index - 1)
            active_limits = (
                self.limit_switch_active_mask
                & self.limit_switch_present_mask
            )
            if flags != 0 or argument != 0:
                status = 4
            elif (
                self.faults
                or self.motion_queue
                or self.position_lock_active
                or self.homing_state == 1
            ):
                status = 8
            elif (
                not (self.limit_switch_present_mask & limit_bit)
                or self.parameters[0x20] == 0
            ):
                status = 5
            elif active_limits & ~limit_bit:
                self.homing_state = 4
                self.homing_encoder_capture_polls = 0
                self.run_state = 2
                self.closed = False
                self.current_ma = 0
                status = 6
            elif active_limits & limit_bit:
                self.current_ma = 0
                self.closed = False
                if self.calibration_valid and not self.encoder_valid:
                    self.homing_state = 1
                    self.homing_encoder_capture_polls = 0
                    self.run_state = 11
                else:
                    self.position = 0
                    self.target = 0
                    self.homing_state = 2
                    self.run_state = 2
                value = self.homing_state
            else:
                self.homing_state = 1
                self.homing_polls = 0
                self.homing_encoder_capture_polls = 0
                self.run_state = 11
                self.closed = False
                self.current_ma = self.parameters[0x20]
                value = self.homing_state
        else:
            status = 3
        return [] if broadcast else [
            ack_frame(self.node, 3, opcode, sequence, status, value)
        ]

    def _motion(self, data: bytes, closed: bool) -> List[Dict[str, Any]]:
        sequence = data[5]
        speed_level = data[4]
        acceleration_level = data[6]
        command_class = 2 if closed else 1
        servo_motion = data[0] == SERVO_HEADER
        if servo_motion:
            angle = int.from_bytes(data[1:3], "little")
            valid_payload = (
                closed
                and data[3] == 0
                and SERVO_ANGLE_MIN <= angle <= SERVO_ANGLE_MAX
                and data[7] == SERVO_TRAILER
            )
        else:
            direction = -1 if data[0] & 1 else 1
            count = int.from_bytes(data[1:4], "little")
            valid_payload = (
                data[0] & 0xFE == MOTION_HEADER
                and data[7] == MOTION_TRAILER
                and count != 0
            )
        if not (
            valid_payload
            and MOTION_LEVEL_MIN <= speed_level <= MOTION_LEVEL_MAX
            and MOTION_ACCELERATION_LEVEL_MIN
            <= acceleration_level
            <= MOTION_LEVEL_MAX
        ):
            return []
        request_key = (
            (CLOSED_BASE if closed else OPEN_BASE) | self.node,
            bytes(data),
        )
        now = time.monotonic()

        def remember_ack(status: int, value: int) -> List[Dict[str, Any]]:
            self.motion_ack_cache[request_key] = (
                status, value, now + DUPLICATE_WINDOW_S,
            )
            return [ack_frame(
                self.node, command_class, 0, sequence,
                status, value,
            )]

        cached = self.motion_ack_cache.get(request_key)
        if cached is not None:
            status, value, expires_at = cached
            if now <= expires_at:
                return [ack_frame(
                    self.node, command_class, 0, sequence,
                    status, value,
                )]
            self.motion_ack_cache.pop(request_key, None)
        for item in self.motion_queue:
            if item["requestKey"] == request_key:
                return remember_ack(
                    0, int(item["acceptedOutstanding"])
                )
        outstanding = len(self.motion_queue)
        try:
            rates = motion_rates_from_levels(
                speed_level,
                acceleration_level,
                self.parameters[0x10],
                self.parameters[0x11],
                self.parameters[0x49],
                self.parameters[0x4A],
            )
        except ValueError:
            return remember_ack(5, outstanding)
        if self.faults or self.position_lock_active:
            return remember_ack(6, outstanding)
        if self.homing_state == 1:
            return remember_ack(8, outstanding)
        if closed and not (self.encoder_valid and self.calibration_valid):
            return remember_ack(6, outstanding)
        if len(self.motion_queue) >= self.motion_capacity:
            return remember_ack(8, outstanding)
        if any(
            int(item["sequence"]) == sequence
            for item in self.motion_queue
        ):
            return remember_ack(8, outstanding)
        self.last_speed_level = speed_level
        self.last_acceleration_level = acceleration_level
        self.last_actual_speed = rates["actualSpeed"]
        self.last_actual_acceleration = rates["actualAcceleration"]
        accepted_outstanding = len(self.motion_queue) + 1
        queued_motion = {
            "kind": "servo" if servo_motion else "relative",
            "closed": closed,
            "sequence": sequence,
            "speedLevel": speed_level,
            "accelerationLevel": acceleration_level,
            "requestKey": request_key,
            "acceptedOutstanding": accepted_outstanding,
        }
        if servo_motion:
            queued_motion["angle"] = angle
        else:
            queued_motion["direction"] = direction
            queued_motion["count"] = count
        self.motion_queue.append(queued_motion)
        if len(self.motion_queue) == 1:
            self._activate_motion_head()
        return remember_ack(0, accepted_outstanding)

    def _activate_motion_head(
        self, terminal_closed: Optional[bool] = None
    ) -> None:
        if not self.motion_queue:
            self.target = self.position
            hold_mode = self.parameters[0x33]
            keep_open = hold_mode == 1 and terminal_closed is False
            keep_closed = hold_mode == 2 and terminal_closed is True
            if keep_open or keep_closed:
                self.run_state = 6
                self.closed = keep_closed
                self.current_ma = self.parameters[0x21]
            else:
                self.run_state = 2
                self.closed = False
                self.current_ma = 0
            return
        motion = self.motion_queue[0]
        self.closed = bool(motion["closed"])
        if self._is_servo_motion(motion):
            relative = self._servo_delta(
                self.position,
                int(motion["angle"]),
            )
        else:
            relative = int(motion["direction"]) * int(motion["count"])
        self.target = max(-0x80000000, min(
            0x7FFFFFFF,
            self.position + relative,
        ))
        self.run_state = 5 if self.closed else 3
        self.current_ma = self.parameters[0x20]

    def _advance_motion(self) -> None:
        if not self.motion_queue:
            return
        completed = self.motion_queue[0]
        self.position = self.target
        self.motion_queue.pop(0)
        self.last_motion_sequence = int(completed["sequence"])
        self._activate_motion_head(bool(completed["closed"]))

    def _clear_motion_queue(self) -> None:
        expires_at = time.monotonic() + DUPLICATE_WINDOW_S
        for motion in self.motion_queue:
            self.motion_ack_cache[motion["requestKey"]] = (
                6, 0, expires_at,
            )
        self.motion_queue.clear()
        self.position_lock_active = False
        self.closed = False
        self.run_state = 2
        self.current_ma = 0
        self.target = self.position

    @staticmethod
    def _is_servo_motion(motion: Dict[str, Any]) -> bool:
        return motion.get("kind") == "servo" or "angle" in motion

    @staticmethod
    def _calibration_geometry_key(values: Dict[int, int]) -> tuple:
        key = (
            int(values[0x10]),
            int(values[0x11]),
            int(values[0x29]),
            int(values[0x2A]),
            int(values[PARAM_ENCODER_MOUNT_MODE]),
        )
        if (
            values[PARAM_ENCODER_MOUNT_MODE]
            == ENCODER_MOUNT_GEARBOX_OUTPUT
        ):
            return key + (
                int(values[PARAM_GEAR_RATIO_NUM]),
                int(values[PARAM_GEAR_RATIO_DEN]),
            )
        # Direct mode deliberately preserves the legacy 1:1 calibration
        # identity; dormant ratio fields do not invalidate it.
        return key

    def _servo_delta(self, position: int, angle: int) -> int:
        motor_microsteps_per_revolution = (
            int(self.parameters[0x10]) * int(self.parameters[0x11])
        )
        output_mount = (
            int(self.parameters[PARAM_ENCODER_MOUNT_MODE])
            == ENCODER_MOUNT_GEARBOX_OUTPUT
        )
        ratio_num = int(self.parameters[PARAM_GEAR_RATIO_NUM]) \
            if output_mount else 1
        ratio_den = int(self.parameters[PARAM_GEAR_RATIO_DEN]) \
            if output_mount else 1
        # Keep the rational output revolution exact.  scaled_delta uses a
        # denominator of 360*ratio_den motor microsteps, so non-integer ratios
        # such as 47/3 do not get rounded before shortest-path selection.
        turn_numerator = motor_microsteps_per_revolution * ratio_num
        scaled_turn = turn_numerator * 360
        scaled_target = angle * turn_numerator
        scaled_position = position * 360 * ratio_den
        positive_delta = (scaled_target - scaled_position) % scaled_turn
        # An exact half-turn deliberately remains positive.
        if positive_delta * 2 > scaled_turn:
            positive_delta -= scaled_turn
        divisor = 360 * ratio_den
        if positive_delta >= 0:
            return (positive_delta + divisor // 2) // divisor
        return -((-positive_delta + divisor // 2) // divisor)

    def _queued_relative_remaining(self) -> int:
        origin = self.position
        predicted = origin
        for motion in self.motion_queue:
            if self._is_servo_motion(motion):
                relative = self._servo_delta(
                    predicted,
                    int(motion["angle"]),
                )
            else:
                relative = (
                    int(motion["direction"]) * int(motion["count"])
                )
            predicted = max(
                -0x80000000,
                min(0x7FFFFFFF, predicted + relative),
            )
        return max(
            -0x80000000,
            min(0x7FFFFFFF, predicted - origin),
        )

    def _parameter(self, data: bytes) -> List[Dict[str, Any]]:
        opcode, sequence, parameter_id = data[0], data[1], data[2]
        value = struct.unpack("<i", data[4:8])[0]
        status = 0
        response_value = 0
        if opcode == PARAM_GET:
            if parameter_id not in self.parameters:
                status = 5
            else:
                response_value = self.parameters[parameter_id]
        elif (
            opcode in (PARAM_SET, PARAM_SAVE, PARAM_DEFAULTS)
            and self.homing_state == 1
        ):
            status = 8
        elif opcode == PARAM_SET:
            if (
                parameter_id == 0x01
                or parameter_id not in self.parameters
            ):
                status = 5
            else:
                previous_geometry = self._calibration_geometry_key(
                    self.parameters
                )
                candidate = dict(self.parameters)
                candidate[parameter_id] = value
                homing_bit = 1 << (int(candidate[0x4B]) - 1) \
                    if 1 <= int(candidate[0x4B]) <= 4 else 0
                if (
                    not parameters_valid(candidate)
                    or not (self.limit_switch_present_mask & homing_bit)
                ):
                    status = 5
                else:
                    self.parameters = candidate
                    response_value = value
                    if self._calibration_geometry_key(
                        self.parameters
                    ) != previous_geometry:
                        self.calibration_valid = False
        elif opcode == PARAM_SAVE:
            self.saved = dict(self.parameters)
        elif opcode == PARAM_DEFAULTS:
            node = self.node
            bitrate = self.parameters[0x02]
            self.parameters = default_parameters(node)
            self.parameters[0x02] = bitrate
            self.calibration_valid = False
        else:
            status = 3
        return [ack_frame(self.node, 4, opcode, sequence, status,
                          response_value)]

    def _pair(self, data: bytes) -> List[Dict[str, Any]]:
        if not self.pair_window:
            return []
        opcode, sequence = data[0], data[1]
        uid_hash = struct.unpack("<I", data[2:6])[0]
        requested_node = data[6]
        if opcode == PAIR_DISCOVER:
            if uid_hash not in (0, self.UID):
                return []
            return [pair_response_frame(opcode, sequence, self.UID,
                                        self.node, 0)]
        if opcode == PAIR_ASSIGN:
            if uid_hash != self.UID:
                return []
            if not 1 <= requested_node <= 127:
                return [pair_response_frame(opcode, sequence, self.UID,
                                            self.node, 5)]
            self.node = requested_node
            self.parameters[0x01] = requested_node
            self.pair_window = False
            self.run_state = 2
            return [pair_response_frame(opcode, sequence, self.UID,
                                        self.node, 0)]
        return []

    def _status_a(self) -> Dict[str, Any]:
        flags = (1 if self.node else 0)
        if self.motion_queue or self.homing_state == 1:
            flags |= 1 << 1
        else:
            flags |= 1 << 2
        if self.encoder_valid:
            flags |= 1 << 3
        if self.calibration_valid:
            flags |= 1 << 4
        if self.closed:
            flags |= 1 << 6
        if self.position_lock_active:
            flags |= 1 << 7
        data = bytes((
            self.run_state, self.calibration_state, flags,
            self.last_motion_sequence & 0xFF,
        )) + struct.pack("<I", self.faults)
        return frame(STATUS_A_BASE | self.node, data)

    def _status_b(self) -> Dict[str, Any]:
        return frame(
            STATUS_B_BASE | self.node,
            i32_bytes(self.position) + i32_bytes(self.target),
        )

    def _status_c(self) -> Dict[str, Any]:
        position_error = max(
            -0x8000,
            min(0x7FFF, self.target - self.position),
        )
        motor_microsteps_per_revolution = (
            int(self.parameters[0x10]) * int(self.parameters[0x11])
        )
        if (
            self.parameters[PARAM_ENCODER_MOUNT_MODE]
            == ENCODER_MOUNT_GEARBOX_OUTPUT
        ):
            scaled_turn = (
                motor_microsteps_per_revolution
                * int(self.parameters[PARAM_GEAR_RATIO_NUM])
            )
            scaled_position = (
                self.position * int(self.parameters[PARAM_GEAR_RATIO_DEN])
            )
        else:
            scaled_turn = motor_microsteps_per_revolution
            scaled_position = self.position
        encoder_raw = (scaled_position % scaled_turn) * 16384 // scaled_turn
        return frame(
            STATUS_C_BASE | self.node,
            struct.pack(
                "<hhHH", 0, position_error, encoder_raw, self.current_ma
            ),
        )

    def _status_d(self) -> Dict[str, Any]:
        active = bool(self.motion_queue)
        motion = self.motion_queue[0] if active else None
        active_sequence = int(motion["sequence"]) if motion else 0xFF
        flags = (1 if active else 0)
        relative_remaining = self._queued_relative_remaining()
        data = bytes((
            len(self.motion_queue),
            self.motion_capacity,
            active_sequence,
            flags,
        )) + struct.pack("<i", relative_remaining)
        return frame(STATUS_D_BASE | self.node, data)

    def _status_e(self) -> Dict[str, Any]:
        present = self.limit_switch_present_mask & LIMIT_SWITCH_MASK
        active = self.limit_switch_active_mask & present
        data = bytes((
            present,
            active,
            LIMIT_STATUS_FORMAT,
            self.homing_state,
            self.parameters[0x4B],
            self.parameters[0x4C],
            self.parameters[0x4D],
            0,
        ))
        return frame(STATUS_E_BASE | self.node, data)

    def _advance_homing(self) -> None:
        if self.homing_state != 1:
            return
        bit = 1 << (int(self.parameters[0x4B]) - 1)
        any_active = (
            self.limit_switch_active_mask
            & self.limit_switch_present_mask
        )
        if any_active & ~bit:
            self.homing_state = 4
            self.run_state = 2
            self.closed = False
            self.current_ma = 0
            self.homing_encoder_capture_polls = 0
            return
        if self.limit_switch_active_mask & bit:
            if self.calibration_valid and not self.encoder_valid:
                self.current_ma = 0
                self.homing_encoder_capture_polls += 1
                if (
                    self.homing_encoder_capture_polls
                    >= SIM_HOMING_ENCODER_CAPTURE_POLLS
                ):
                    self.homing_state = 4
                    self.run_state = 2
                    self.homing_encoder_capture_polls = 0
                return
            self.position = 0
            self.target = 0
            self.homing_state = 2
            self.run_state = 2
            self.closed = False
            self.current_ma = 0
            self.homing_encoder_capture_polls = 0
            return
        if self.homing_encoder_capture_polls:
            self.homing_state = 4
            self.run_state = 2
            self.closed = False
            self.current_ma = 0
            self.homing_encoder_capture_polls = 0
            return
        self.homing_polls += 1
        direction = -1 if int(self.parameters[0x4C]) else 1
        step = max(1, int(self.parameters[0x4D]) ** 2 // 20)
        self.position += direction * step
        self.target = self.position
        if self.homing_polls >= SIM_HOMING_MAX_POLLS:
            self.homing_state = 3
            self.run_state = 2
            self.closed = False
            self.current_ma = 0


class MotorService:
    def __init__(self) -> None:
        self.transport: Optional[Any] = None
        self.connected = False
        self.simulate = False
        self.interface = ""
        self.node = 0
        self.sequence = 0
        self.motion_sequence = 0
        self.sequence_by_node: Dict[int, int] = {}
        self.motion_sequence_by_node: Dict[int, int] = {}
        self.pending_parameters: Dict[
            tuple[int, int], tuple[int, float]
        ] = {}
        self.pending_pair: Dict[int, tuple] = {}
        self.motion_replays: Dict[int, Dict[str, Any]] = {}
        self.motion_replay_next = 1
        self.session_epoch = 0
        self.lock = threading.RLock()

    def dispatch(self, action: str, params: Dict[str, Any]) -> Dict[str, Any]:
        methods = {
            "connect": self.connect,
            "disconnect": self.disconnect,
            "set_node": self.set_node,
            "ping": self.ping,
            "status": self.status,
            "status_many": self.status_many,
            "move": self.move,
            "servo_move": self.servo_move,
            "motion_replay": self.motion_replay,
            "stop": self.stop,
            "disable": self.disable,
            "clear_faults": self.clear_faults,
            "calibration_start": self.calibration_start,
            "calibration_abort": self.calibration_abort,
            "position_lock": self.position_lock,
            "position_unlock": self.position_unlock,
            "homing_start": self.homing_start,
            "param_get": self.param_get,
            "param_set": self.param_set,
            "param_save": self.param_save,
            "param_defaults": self.param_defaults,
            "pair_discover": self.pair_discover,
            "pair_assign": self.pair_assign,
            "sim_pair_window": self.sim_pair_window,
            "firmware_update_frames": self.firmware_update_frames,
        }
        if action not in methods:
            raise ValueError("未知操作")
        return methods[action](params)

    def connect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        interface = params.get("interface", "")
        if not isinstance(interface, str) or not interface.strip():
            raise ValueError("CAN 接口不能为空")
        interface = interface.strip()
        if len(interface) > 32 or "\x00" in interface:
            raise ValueError("CAN 接口名称无效")
        node = bounded_int("节点 ID", params.get("nodeId"), 0, 127)
        simulate = boolean("仿真模式", params.get("simulate"))
        requested_epoch = params.get("sessionEpoch")
        if requested_epoch is None:
            session_epoch = self.session_epoch + 1
        else:
            session_epoch = bounded_int(
                "CAN 会话代号", requested_epoch, 0, 0x7FFFFFFF
            )
        self.disconnect({})
        if simulate:
            transport: Any = SimulatedTransport(
                self._receive_frame, self._transport_error
            )
        else:
            transport = SocketCanTransport(
                self._receive_frame, self._transport_error
            )
        transport.connect(interface, node)
        with self.lock:
            self.transport = transport
            self.connected = True
            self.simulate = simulate
            self.interface = interface
            self.node = node
            self.sequence = self.sequence_by_node.get(node, 0)
            self.motion_sequence = self.motion_sequence_by_node.get(node, 0)
            self.session_epoch = session_epoch
        emit("connection", {
            "connected": True, "interface": interface,
            "nodeId": node, "simulate": simulate,
        })
        return {"connected": True, "nodeId": node, "simulate": simulate}

    def disconnect(self, params: Dict[str, Any]) -> Dict[str, Any]:
        requested_epoch = params.get("sessionEpoch")
        session_epoch = None
        if requested_epoch is not None:
            session_epoch = bounded_int(
                "CAN 会话代号", requested_epoch, 0, 0x7FFFFFFF
            )
        with self.lock:
            transport = self.transport
            was_connected = self.connected
            self.transport = None
            self.connected = False
            self.pending_parameters.clear()
            self.pending_pair.clear()
            self.motion_replays.clear()
        if transport is not None:
            transport.close()
        if session_epoch is not None:
            with self.lock:
                self.session_epoch = session_epoch
        if was_connected:
            emit("connection", {"connected": False})
        return {"connected": False}

    def set_node(self, params: Dict[str, Any]) -> Dict[str, Any]:
        node = bounded_int("节点 ID", params.get("nodeId"), 0, 127)
        transport = self._require_transport()
        transport.set_node(node)
        with self.lock:
            self.node = node
            self.sequence = self.sequence_by_node.get(node, 0)
            self.motion_sequence = self.motion_sequence_by_node.get(node, 0)
        emit("connection", {
            "connected": True, "interface": self.interface,
            "nodeId": node, "simulate": self.simulate,
        })
        return {"nodeId": node}

    def ping(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._control(PING, params=params)

    def status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        flags = bounded_int(
            "状态标志", params.get("flags", STATUS_ALL), 0, STATUS_ALL
        )
        return self._control(GET_STATUS, params=params, flags=flags)

    def status_many(self, params: Dict[str, Any]) -> Dict[str, Any]:
        raw_nodes = params.get("nodeIds")
        if not isinstance(raw_nodes, list):
            raise ValueError("节点 ID 列表必须是数组")
        flags = bounded_int(
            "状态标志", params.get("flags", STATUS_ALL), 0, STATUS_ALL
        )
        nodes: List[int] = []
        seen = set()
        for raw_node in raw_nodes:
            node = bounded_int("节点 ID", raw_node, 1, 127)
            if node not in seen:
                nodes.append(node)
                seen.add(node)
        if not nodes:
            raise ValueError("节点 ID 列表不能为空")
        if len(nodes) > STATUS_MANY_MAX_NODES:
            raise ValueError(
                "单批状态请求最多包含{}个节点".format(
                    STATUS_MANY_MAX_NODES
                )
            )

        requests = []
        for node in nodes:
            sequence = self._next_sequence(node)
            data = bytes((GET_STATUS, sequence, flags, 0))
            data += struct.pack("<I", 0)
            self._send(frame(CONTROL_BASE | node, data))
            requests.append({"nodeId": node, "sequence": sequence})
        return {"nodeIds": nodes, "flags": flags, "requests": requests}

    def stop(self, params: Dict[str, Any]) -> Dict[str, Any]:
        immediate = boolean("立即停止", params.get("immediate", False))
        broadcast = boolean("广播", params.get("broadcast", False))
        return self._control(
            STOP,
            params=params,
            flags=1 if immediate else 0,
            broadcast=broadcast,
        )

    def disable(self, params: Dict[str, Any]) -> Dict[str, Any]:
        broadcast = boolean("广播", params.get("broadcast", False))
        return self._control(DISABLE, params=params, broadcast=broadcast)

    def clear_faults(self, params: Dict[str, Any]) -> Dict[str, Any]:
        mask = bounded_int("故障掩码", params.get("mask", 0), 0,
                           0xFFFFFFFF)
        return self._control(CLEAR_FAULTS, params=params, argument=mask)

    def calibration_start(self, params: Dict[str, Any]) -> Dict[str, Any]:
        current = bounded_int("校验电流", params.get("currentMa"), 1, 2450)
        persist = boolean("持久化", params.get("persist", False))
        return self._control(CAL_START, params=params,
                             flags=1 if persist else 0,
                             argument=current)

    def calibration_abort(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._control(CAL_ABORT, params=params)

    def position_lock(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._control(POSITION_LOCK, params=params)

    def position_unlock(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._control(POSITION_UNLOCK, params=params)

    def homing_start(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._control(HOMING_START, params=params)

    def move(self, params: Dict[str, Any]) -> Dict[str, Any]:
        try:
            node = self._target_node(params)
            closed = boolean("闭环", params.get("closed"))
            direction = bounded_int(
                "方向", params.get("direction"), 0, 1
            )
            count = bounded_int(
                "微步数", params.get("count"), 1, 0xFFFFFF
            )
            speed_level = bounded_int(
                "速度等级", params.get("speedLevel"),
                MOTION_LEVEL_MIN, MOTION_LEVEL_MAX
            )
            acceleration_level = bounded_int(
                "加速度等级", params.get("accelerationLevel"),
                MOTION_ACCELERATION_LEVEL_MIN, MOTION_LEVEL_MAX
            )
        except ValueError as exc:
            raise RequestValidationError(str(exc)) from exc
        sequence = self._next_motion_sequence(node)
        data = bytearray(8)
        data[0] = MOTION_HEADER | direction
        data[1:4] = count.to_bytes(3, "little")
        data[4] = speed_level
        data[5] = sequence
        data[6] = acceleration_level
        data[7] = MOTION_TRAILER
        item = frame(
            (CLOSED_BASE if closed else OPEN_BASE) | node,
            bytes(data),
        )
        replay_id = self._remember_motion_replay(item, sequence, node)
        self._send(item)
        return {
            "sequence": sequence,
            "speedLevel": speed_level,
            "accelerationLevel": acceleration_level,
            "replayId": replay_id,
            "nodeId": node,
        }

    def servo_move(self, params: Dict[str, Any]) -> Dict[str, Any]:
        try:
            node = self._target_node(params)
            angle = bounded_int(
                "舵机角度", params.get("angle"),
                SERVO_ANGLE_MIN, SERVO_ANGLE_MAX,
            )
            speed_level = bounded_int(
                "速度等级", params.get("speedLevel"),
                MOTION_LEVEL_MIN, MOTION_LEVEL_MAX,
            )
            acceleration_level = bounded_int(
                "加速度等级", params.get("accelerationLevel"),
                MOTION_ACCELERATION_LEVEL_MIN, MOTION_LEVEL_MAX,
            )
        except ValueError as exc:
            raise RequestValidationError(str(exc)) from exc
        sequence = self._next_motion_sequence(node)
        data = bytearray(8)
        data[0] = SERVO_HEADER
        data[1:3] = angle.to_bytes(2, "little")
        data[3] = 0
        data[4] = speed_level
        data[5] = sequence
        data[6] = acceleration_level
        data[7] = SERVO_TRAILER
        item = frame(CLOSED_BASE | node, bytes(data))
        replay_id = self._remember_motion_replay(item, sequence, node)
        self._send(item)
        return {
            "sequence": sequence,
            "angle": angle,
            "speedLevel": speed_level,
            "accelerationLevel": acceleration_level,
            "replayId": replay_id,
            "nodeId": node,
        }

    def motion_replay(self, params: Dict[str, Any]) -> Dict[str, Any]:
        replay_id = bounded_int(
            "运动重发 ID",
            params.get("replayId"),
            1,
            0x7FFFFFFF,
        )
        now = time.monotonic()
        record = self.motion_replays.get(replay_id)
        if record is None or now > float(record["expiresAt"]):
            self.motion_replays.pop(replay_id, None)
            raise RuntimeError(
                "运动帧重发窗口已过期，执行状态不确定"
            )
        original = record["frame"]
        replay = frame(int(original["id"]), bytes(original["data"]))
        self._send(replay)
        return {
            "sequence": int(record["sequence"]),
            "replayId": replay_id,
            "nodeId": int(record["nodeId"]),
            "replayed": True,
        }

    def _remember_motion_replay(
        self,
        item: Dict[str, Any],
        sequence: int,
        node: int,
    ) -> int:
        now = time.monotonic()
        for replay_id, record in list(self.motion_replays.items()):
            if now > float(record["expiresAt"]):
                self.motion_replays.pop(replay_id, None)

        replay_id = self.motion_replay_next
        while replay_id in self.motion_replays:
            replay_id = 1 if replay_id >= 0x7FFFFFFF else replay_id + 1
        self.motion_replay_next = (
            1 if replay_id >= 0x7FFFFFFF else replay_id + 1
        )
        self.motion_replays[replay_id] = {
            "frame": {
                "id": int(item["id"]),
                "data": bytes(item["data"]),
            },
            "sequence": sequence,
            "nodeId": node,
            "expiresAt": now + MOTION_REPLAY_WINDOW_S,
        }
        return replay_id

    def param_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        parameter_id = bounded_int(
            "参数 ID", params.get("parameterId"), 0, 255
        )
        return self._parameter(PARAM_GET, parameter_id, 0, params)

    def param_set(self, params: Dict[str, Any]) -> Dict[str, Any]:
        parameter_id = bounded_int(
            "参数 ID", params.get("parameterId"), 0, 255
        )
        value = bounded_int("参数值", params.get("value"),
                            -0x80000000, 0x7FFFFFFF)
        return self._parameter(PARAM_SET, parameter_id, value, params)

    def param_save(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._parameter(PARAM_SAVE, 0, 0, params)

    def param_defaults(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self._parameter(PARAM_DEFAULTS, 0, 0, params)

    def pair_discover(self, params: Dict[str, Any]) -> Dict[str, Any]:
        uid_hash = bounded_int(
            "UID", params.get("uidHash", 0), 0, 0xFFFFFFFF
        )
        sequence = self._next_sequence(0)
        data = bytes((PAIR_DISCOVER, sequence))
        data += struct.pack("<I", uid_hash) + b"\x00\x00"
        self._send(frame(PAIR_REQUEST, data))
        return {"sequence": sequence}

    def pair_assign(self, params: Dict[str, Any]) -> Dict[str, Any]:
        uid_hash = bounded_int(
            "UID", params.get("uidHash"), 1, 0xFFFFFFFF
        )
        node = bounded_int("新节点", params.get("nodeId"), 1, 127)
        persist = boolean("持久化", params.get("persist", False))
        sequence = self._next_sequence(0)
        data = bytes((PAIR_ASSIGN, sequence))
        data += struct.pack("<I", uid_hash)
        data += bytes((node, 1 if persist else 0))
        self.pending_pair[sequence] = (uid_hash, node)
        self._send(frame(PAIR_REQUEST, data))
        return {"sequence": sequence}

    def sim_pair_window(self, _params: Dict[str, Any]) -> Dict[str, Any]:
        transport = self._require_transport()
        if not self.simulate or not isinstance(transport, SimulatedTransport):
            raise ValueError("仅仿真模式支持此操作")
        transport.open_pair_window()
        return {"open": True}

    def firmware_update_frames(
        self, params: Dict[str, Any]
    ) -> Dict[str, Any]:
        node = self._target_node(params)
        raw_frames = params.get("frames")
        if not isinstance(raw_frames, list) or not 1 <= len(raw_frames) <= 8:
            raise ValueError("固件升级单批必须包含 1–8 帧")
        frames = []
        for raw_data in raw_frames:
            if (
                not isinstance(raw_data, list) or len(raw_data) != 8
                or any(isinstance(value, bool) or not isinstance(value, int)
                       or value < 0 or value > 255 for value in raw_data)
            ):
                raise ValueError("固件升级帧必须是 8 个字节")
            frames.append(frame(
                FW_UPDATE_REQUEST_BASE | node, bytes(raw_data)
            ))
        for item in frames:
            self._send(item)
        return {"nodeId": node, "sent": len(frames)}

    def _control(self, opcode: int, params: Optional[Dict[str, Any]] = None,
                 flags: int = 0, argument: int = 0,
                 broadcast: bool = False) -> Dict[str, Any]:
        node = 0 if broadcast else self._target_node(params or {})
        sequence = self._next_sequence(node)
        data = bytes((opcode, sequence, flags, 0))
        data += struct.pack("<I", argument)
        self._send(frame(CONTROL_BASE | node, data))
        return {
            "sequence": sequence,
            "broadcast": broadcast,
            "nodeId": node,
        }

    def _parameter(self, opcode: int, parameter_id: int,
                   value: int, params: Dict[str, Any]) -> Dict[str, Any]:
        node = self._target_node(params)
        sequence = self._next_sequence(node)
        data = bytes((opcode, sequence, parameter_id, 0))
        data += struct.pack("<i", value)
        pending_key = (node, sequence)
        if opcode in (PARAM_GET, PARAM_SET):
            now = time.monotonic()
            with self.lock:
                for key, (_parameter_id, expires_at) in list(
                    self.pending_parameters.items()
                ):
                    if now > expires_at:
                        self.pending_parameters.pop(key, None)
                self.pending_parameters[pending_key] = (
                    parameter_id,
                    now + PARAMETER_PENDING_TTL_S,
                )
        try:
            self._send(frame(PARAM_BASE | node, data))
        except Exception:
            if opcode in (PARAM_GET, PARAM_SET):
                with self.lock:
                    pending = self.pending_parameters.get(pending_key)
                    if pending is not None and pending[0] == parameter_id:
                        self.pending_parameters.pop(pending_key, None)
            raise
        return {
            "sequence": sequence,
            "parameterId": parameter_id,
            "nodeId": node,
        }

    def _send(self, item: Dict[str, Any]) -> None:
        transport = self._require_transport()
        emit("frame", frame_json(item, "tx"))
        transport.send(item)

    def _receive_frame(self, item: Dict[str, Any]) -> None:
        emit("frame", frame_json(item, "rx"))
        try:
            decoded = self._decode(item)
        except Exception as exc:
            emit("error", {"message": "协议解码失败: {}".format(exc)})
            return
        if decoded is not None:
            emit(decoded["event"], decoded["data"])

    def _decode(self, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        can_id, data = item["id"], item["data"]
        base = can_id & ~0x7F
        timestamp = item.get("timestamp", time.time())
        if base == ACK_BASE:
            node = can_id & 0x7F
            command_class, opcode, sequence, status = data[:4]
            if not 1 <= node <= 127 or not 1 <= command_class <= 5:
                raise ValueError("ACK 字段非法")
            if status not in ACK_NAMES:
                raise ValueError("ACK 状态非法")
            value = struct.unpack("<i", data[4:8])[0]
            result = {
                "nodeId": node, "commandClass": command_class,
                "opcode": opcode, "sequence": sequence,
                "status": status, "statusName": ACK_NAMES[status],
                "ok": status == 0, "value": value,
                "timestamp": timestamp,
                "sessionEpoch": self.session_epoch,
            }
            if command_class == 4:
                with self.lock:
                    pending = self.pending_parameters.pop(
                        (node, sequence), None
                    )
                if pending is not None and time.monotonic() <= pending[1]:
                    result["parameterId"] = pending[0]
            if command_class == 3 and opcode == PING and status == 0:
                unsigned = value & 0xFFFFFFFF
                product_id = unsigned >> 24 & 0xFF
                result["hardwareProductId"] = product_id
                result["hardwareModel"] = HARDWARE_MODELS.get(
                    product_id, "未知板型"
                )
                result["firmwareVersion"] = "{}.{}.{}".format(
                    unsigned >> 16 & 0xFF,
                    unsigned >> 8 & 0xFF,
                    unsigned & 0xFF,
                )
            return {"event": "ack", "data": result}
        if base == STATUS_A_BASE:
            node = can_id & 0x7F
            run, calibration, flags, sequence = data[:4]
            faults = struct.unpack("<I", data[4:8])[0]
            names = [
                name for bit, name in FAULT_NAMES.items()
                if faults & 1 << bit
            ]
            return {"event": "status", "data": {
                "part": "A", "nodeId": node,
                "runState": run, "runStateName": RUN_NAMES.get(run, str(run)),
                "calibrationState": calibration,
                "calibrationStateName": CAL_NAMES.get(calibration,
                                                       str(calibration)),
                "paired": bool(flags & 1), "moving": bool(flags & 2),
                "targetReached": bool(flags & 4),
                "encoderValid": bool(flags & 8),
                "calibrationValid": bool(flags & 16),
                "buttonPressed": bool(flags & 32),
                "closedLoopActive": bool(flags & 64),
                "positionLockActive": bool(flags & 128),
                "lastMotionSequence": sequence,
                "faultFlags": faults, "faultNames": names,
                "timestamp": timestamp,
            }}
        if base == STATUS_B_BASE:
            current, target = struct.unpack("<ii", data)
            return {"event": "status", "data": {
                "part": "B", "nodeId": can_id & 0x7F,
                "currentPosition": current,
                "absoluteTargetPosition": target,
                "timestamp": timestamp,
            }}
        if base == STATUS_C_BASE:
            velocity, position_error, angle, current = struct.unpack(
                "<hhHH", data
            )
            return {"event": "status", "data": {
                "part": "C", "nodeId": can_id & 0x7F,
                "velocity": velocity * 10,
                "positionError": position_error, "encoderRaw": angle,
                "appliedCurrentMa": current, "timestamp": timestamp,
            }}
        if base == STATUS_D_BASE:
            outstanding, capacity, active_sequence, flags = data[:4]
            relative_remaining = struct.unpack("<i", data[4:8])[0]
            return {"event": "status", "data": {
                "part": "D", "nodeId": can_id & 0x7F,
                "queueOutstanding": outstanding,
                "queueCapacity": capacity,
                "activeSequence":
                    active_sequence if flags & 1 else None,
                "queueActive": bool(flags & 1),
                "handoffPending": bool(flags & 2),
                "relativeRemaining": relative_remaining,
                "timestamp": timestamp,
            }}
        if base == STATUS_E_BASE:
            node = can_id & 0x7F
            present, active, format_version = data[:3]
            if (
                not 1 <= node <= 127
                or present & ~LIMIT_SWITCH_MASK
                or active & ~LIMIT_SWITCH_MASK
                or active & ~present
                or format_version not in (
                    LIMIT_STATUS_FORMAT_LEGACY,
                    LIMIT_STATUS_FORMAT,
                )
            ):
                raise ValueError("Status E 限位字段非法")
            if format_version == LIMIT_STATUS_FORMAT_LEGACY:
                if any(data[3:]):
                    raise ValueError("Status E V1 保留字段非法")
                homing_state = 0
                homing_limit = 0
                homing_direction = 0
                homing_speed = 0
            else:
                homing_state, homing_limit, homing_direction, \
                    homing_speed, reserved = data[3:8]
                if (
                    homing_state not in HOMING_NAMES
                    or not 1 <= homing_limit <= LIMIT_SWITCH_COUNT
                    or not (present & (1 << (homing_limit - 1)))
                    or homing_direction not in (0, 1)
                    or not 1 <= homing_speed <= MOTION_LEVEL_MAX
                    or reserved != 0
                ):
                    raise ValueError("Status E V2 归零字段非法")
            return {"event": "status", "data": {
                "part": "E", "nodeId": node,
                "limitSwitchPresentMask": present,
                "limitSwitchActiveMask": active,
                "limitSwitchFormatVersion": format_version,
                "homingSupported":
                    format_version >= LIMIT_STATUS_FORMAT,
                "homingState": homing_state,
                "homingStateName": HOMING_NAMES.get(
                    homing_state, str(homing_state)
                ),
                "homingLimitSwitch": homing_limit,
                "homingDirection": homing_direction,
                "homingSpeedLevel": homing_speed,
                "timestamp": timestamp,
            }}
        if can_id == PAIR_RESPONSE:
            response_opcode, sequence = data[:2]
            opcode = response_opcode & 0x7F
            if not response_opcode & 0x80 or opcode not in (
                PAIR_DISCOVER, PAIR_ASSIGN
            ):
                raise ValueError("配对响应非法")
            uid_hash = struct.unpack("<I", data[2:6])[0]
            node, status = data[6], data[7]
            result = {
                "opcode": opcode, "sequence": sequence,
                "uidHash": uid_hash, "uidHex": "0x{:08X}".format(uid_hash),
                "nodeId": node, "status": status,
                "statusName": ACK_NAMES.get(status, str(status)),
                "ok": status == 0, "timestamp": timestamp,
            }
            expected = self.pending_pair.get(sequence)
            if opcode == PAIR_ASSIGN and expected == (uid_hash, node):
                self.pending_pair.pop(sequence, None)
                if status == 0:
                    self.set_node({"nodeId": node})
            return {"event": "pair", "data": result}
        if base == FW_UPDATE_RESPONSE_BASE:
            node = can_id & 0x7F
            if not 1 <= node <= 127:
                raise ValueError("固件升级响应节点非法")
            if data[0] == FW_GENERIC_RESPONSE:
                status = data[3]
                if status > 8:
                    raise ValueError("固件升级状态非法")
                return {"event": "firmware-update", "data": {
                    "kind": "response", "nodeId": node,
                    "opcode": data[1], "sequence": data[2],
                    "status": status, "ok": status == 0,
                    "value": struct.unpack("<I", data[4:8])[0],
                    "timestamp": timestamp,
                }}
            if data[0] == FW_WINDOW_RESPONSE:
                return {"event": "firmware-update", "data": {
                    "kind": "window", "nodeId": node,
                    "token": int.from_bytes(data[1:3], "little"),
                    "status": data[3],
                    "bitmap": struct.unpack("<I", data[4:8])[0],
                    "timestamp": timestamp,
                }}
            if data[0] == SCRIPT_RESPONSE:
                status = data[3]
                if status > 8:
                    raise ValueError("脚本响应状态非法")
                return {"event": "script-update", "data": {
                    "kind": "response", "nodeId": node,
                    "opcode": data[1], "sequence": data[2],
                    "status": status, "ok": status == 0,
                    "value": struct.unpack("<I", data[4:8])[0],
                    "timestamp": timestamp,
                }}
            if data[0] == TEACH_RESPONSE:
                status = data[3]
                if status > 8:
                    raise ValueError("示教响应状态非法")
                return {"event": "teach-update", "data": {
                    "kind": "response", "nodeId": node,
                    "opcode": data[1], "sequence": data[2],
                    "status": status, "ok": status == 0,
                    "value": struct.unpack("<I", data[4:8])[0],
                    "timestamp": timestamp,
                }}
            raise ValueError("未知固件升级响应")
        return None

    def _transport_error(self, message: str, fatal: bool = False,
                         source: Optional[Any] = None) -> None:
        if not fatal:
            emit("error", {"message": message})
            return
        with self.lock:
            if source is not None and self.transport is not source:
                emit("error", {"message": message})
                return
            transport = self.transport
            was_connected = self.connected
            self.transport = None
            self.connected = False
            self.pending_parameters.clear()
            self.pending_pair.clear()
            self.motion_replays.clear()
        if transport is not None:
            transport.close()
        emit("error", {"message": message})
        if was_connected:
            emit("connection", {
                "connected": False,
                "reason": "transport-error",
            })

    def _require_transport(self) -> Any:
        with self.lock:
            if not self.connected or self.transport is None:
                raise RuntimeError("尚未连接")
            return self.transport

    def _target_node(self, params: Optional[Dict[str, Any]] = None) -> int:
        values = params or {}
        node = bounded_int(
            "节点 ID",
            values.get("nodeId", self.node),
            0,
            127,
        )
        if node == 0:
            raise ValueError("节点 0 未分配，只能执行配对")
        return node

    def _next_sequence(self, node: Optional[int] = None) -> int:
        target = self.node if node is None else node
        with self.lock:
            sequence = self.sequence_by_node.get(target, 0)
            next_sequence = (sequence + 1) & 0xFF
            self.sequence_by_node[target] = next_sequence
            # Preserve the legacy observable counter for the default node.
            if target == self.node:
                self.sequence = next_sequence
            return sequence

    def _next_motion_sequence(self, node: Optional[int] = None) -> int:
        target = self.node if node is None else node
        with self.lock:
            sequence = self.motion_sequence_by_node.get(target, 0)
            next_sequence = (sequence + 1) & 0xFF
            self.motion_sequence_by_node[target] = next_sequence
            # Preserve the legacy observable counter for the default node.
            if target == self.node:
                self.motion_sequence = next_sequence
            return sequence


def _round_positive_ratio(numerator: int, denominator: int) -> int:
    return (numerator + denominator // 2) // denominator


def motion_rates_from_levels(
    speed_level: int,
    acceleration_level: int,
    full_steps: int,
    microsteps: int,
    speed_limit_rpm: int = SPEED_LEVEL_100_RPM,
    acceleration_limit_rpm_s: int = ACCELERATION_LEVEL_100_RPM_PER_S,
) -> Dict[str, Any]:
    if not MOTION_LEVEL_MIN <= speed_level <= MOTION_LEVEL_MAX:
        raise ValueError("速度等级必须在 1–100")
    if not (
        MOTION_ACCELERATION_LEVEL_MIN
        <= acceleration_level
        <= MOTION_LEVEL_MAX
    ):
        raise ValueError("加速度等级必须在 0–100")
    if not 4 <= full_steps <= 2000 or full_steps % 4:
        raise ValueError("每圈整步数非法")
    if microsteps not in (1, 2, 4, 8, 16, 32, 64, 128, 256):
        raise ValueError("微步细分非法")
    if not 1 <= speed_limit_rpm <= 5000:
        raise ValueError("速度上限非法")
    if not 1 <= acceleration_limit_rpm_s <= 20000:
        raise ValueError("加速度上限非法")

    microsteps_per_revolution = full_steps * microsteps
    rate_denominator = 60 * LEVEL_SQUARE_DENOMINATOR
    requested_speed = max(1, _round_positive_ratio(
        speed_limit_rpm
        * microsteps_per_revolution
        * speed_level
        * speed_level,
        rate_denominator,
    ))
    acceleration_bypassed = (
        acceleration_level == MOTION_ACCELERATION_LEVEL_MIN
    )
    requested_acceleration = None if acceleration_bypassed else max(
        1,
        _round_positive_ratio(
            acceleration_limit_rpm_s
            * microsteps_per_revolution
            * acceleration_level
            * acceleration_level,
            rate_denominator,
        ),
    )
    firmware_speed = 10_000 * microsteps - 2_500
    firmware_acceleration = min(
        375_000 * microsteps,
        1_875_000,
    )
    speed_limit = max(
        1,
        firmware_speed
        * DYNAMIC_LIMIT_NUMERATOR
        // DYNAMIC_LIMIT_DENOMINATOR,
    )
    acceleration_limit = max(
        1,
        firmware_acceleration
        * DYNAMIC_LIMIT_NUMERATOR
        // DYNAMIC_LIMIT_DENOMINATOR,
    )
    actual_speed = min(requested_speed, speed_limit)
    actual_acceleration = (
        None
        if acceleration_bypassed
        else min(requested_acceleration, acceleration_limit)
    )
    return {
        "accelerationBypassed": acceleration_bypassed,
        "requestedSpeed": requested_speed,
        "requestedAcceleration": requested_acceleration,
        "actualSpeed": actual_speed,
        "actualAcceleration": actual_acceleration,
        "speedClamped": actual_speed != requested_speed,
        "accelerationClamped": (
            False
            if acceleration_bypassed
            else actual_acceleration != requested_acceleration
        ),
        "boundaries": {
            "speed": speed_limit,
            "acceleration": acceleration_limit,
        },
    }


OUTPUT_LOCK = threading.Lock()


def write_message(message: Dict[str, Any]) -> None:
    encoded = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    with OUTPUT_LOCK:
        sys.stdout.write(encoded + "\n")
        sys.stdout.flush()


def emit(event: str, data: Dict[str, Any]) -> None:
    write_message({"type": "event", "event": event, "data": data})


def main() -> int:
    service = MotorService()
    for raw_line in sys.stdin:
        if len(raw_line) > 65536:
            write_message({
                "type": "response", "id": -1, "ok": False,
                "error": "请求过长",
            })
            continue
        request_id = -1
        try:
            request = json.loads(raw_line)
            if not isinstance(request, dict):
                raise ValueError("请求必须是对象")
            request_id = bounded_int(
                "请求 ID", request.get("id"), 0, 0x7FFFFFFF
            )
            action = request.get("action")
            params = request.get("params", {})
            if action == "shutdown":
                service.disconnect({})
                write_message({
                    "type": "response", "id": request_id,
                    "ok": True, "result": {},
                })
                return 0
            if not isinstance(action, str) or not isinstance(params, dict):
                raise ValueError("请求格式错误")
            result = service.dispatch(action, params)
            write_message({
                "type": "response", "id": request_id,
                "ok": True, "result": result,
            })
        except Exception as exc:
            write_message({
                "type": "response", "id": request_id,
                "ok": False,
                "error": str(exc),
                "errorCode": (
                    "VALIDATION_ERROR"
                    if isinstance(exc, RequestValidationError)
                    else "BRIDGE_ERROR"
                ),
            })
    service.disconnect({})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
