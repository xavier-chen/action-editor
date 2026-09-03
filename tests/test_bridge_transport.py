import importlib.util
import pathlib
import time
import unittest


MODULE_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "bridge"
    / "lumdriver_bridge.py"
)
SPEC = importlib.util.spec_from_file_location("lumdriver_bridge_tested", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class FakeTransport:
    def __init__(self):
        self.closed = 0
        self.node = None

    def close(self):
        self.closed += 1

    def set_node(self, node):
        self.node = node


class CapturingTransport(FakeTransport):
    def __init__(self):
        super().__init__()
        self.sent = []

    def send(self, item):
        self.sent.append({
            "id": item["id"],
            "data": bytes(item["data"]),
        })


class TransportFailureTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.original_emit = BRIDGE.emit
        BRIDGE.emit = lambda event, data: self.events.append((event, data))

    def tearDown(self):
        BRIDGE.emit = self.original_emit

    def test_fatal_receive_error_disconnects_and_closes_current_transport(self):
        service = BRIDGE.MotorService()
        transport = FakeTransport()
        service.transport = transport
        service.connected = True
        service.pending_parameters[1] = 0x10
        service._transport_error("fatal rx", True, transport)

        self.assertFalse(service.connected)
        self.assertIsNone(service.transport)
        self.assertEqual(transport.closed, 1)
        self.assertEqual(service.pending_parameters, {})
        self.assertIn(("error", {"message": "fatal rx"}), self.events)
        self.assertIn(
            (
                "connection",
                {"connected": False, "reason": "transport-error"},
            ),
            self.events,
        )

    def test_nonfatal_or_stale_transport_error_does_not_drop_current_link(self):
        service = BRIDGE.MotorService()
        current = FakeTransport()
        stale = FakeTransport()
        service.transport = current
        service.connected = True

        service._transport_error("bad frame")
        self.assertTrue(service.connected)
        self.assertIs(service.transport, current)

        service._transport_error("old rx", True, stale)
        self.assertTrue(service.connected)
        self.assertIs(service.transport, current)
        self.assertEqual(current.closed, 0)


class FirmwareUpdateBridgeTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.original_emit = BRIDGE.emit
        BRIDGE.emit = lambda event, data: self.events.append((event, data))
        self.service = BRIDGE.MotorService()
        self.transport = CapturingTransport()
        self.service.transport = self.transport
        self.service.connected = True
        self.service.node = 33

    def tearDown(self):
        BRIDGE.emit = self.original_emit

    def test_firmware_update_batch_is_addressed_and_bounded(self):
        payload = list(range(8))
        result = self.service.firmware_update_frames({
            "nodeId": 33,
            "frames": [payload] * 8,
        })
        self.assertEqual(result, {"nodeId": 33, "sent": 8})
        self.assertTrue(all(
            item["id"] == (BRIDGE.FW_UPDATE_REQUEST_BASE | 33)
            for item in self.transport.sent
        ))
        with self.assertRaisesRegex(ValueError, "1–8"):
            self.service.firmware_update_frames({
                "nodeId": 33, "frames": [payload] * 9,
            })

    def test_firmware_update_response_decodes_unsigned_values(self):
        item = BRIDGE.frame(
            BRIDGE.FW_UPDATE_RESPONSE_BASE | 33,
            bytes((BRIDGE.FW_GENERIC_RESPONSE, BRIDGE.FW_QUERY, 7, 0))
            + bytes.fromhex("FF FF 03 07"),
        )
        decoded = self.service._decode(item)
        self.assertEqual(decoded["event"], "firmware-update")
        self.assertEqual(decoded["data"]["nodeId"], 33)
        self.assertEqual(decoded["data"]["sequence"], 7)
        self.assertEqual(decoded["data"]["value"], 0x0703FFFF)

    def test_native_teach_response_decodes_with_its_own_event_domain(self):
        item = BRIDGE.frame(
            BRIDGE.FW_UPDATE_RESPONSE_BASE | 33,
            bytes((BRIDGE.TEACH_RESPONSE, BRIDGE.TEACH_QUERY, 19, 0))
            + (0x00010305).to_bytes(4, "little"),
        )
        decoded = self.service._decode(item)
        self.assertEqual(decoded["event"], "teach-update")
        self.assertEqual(decoded["data"], {
            "kind": "response",
            "nodeId": 33,
            "opcode": BRIDGE.TEACH_QUERY,
            "sequence": 19,
            "status": 0,
            "ok": True,
            "value": 0x00010305,
            "timestamp": decoded["data"]["timestamp"],
        })

    def test_ping_ack_decodes_product_byte_without_changing_version(self):
        expected_models = {
            0: "未知板型",
            1: "分离式驱动板",
            2: "42 步进电机驱动板",
            3: "20 步进电机驱动板",
        }
        for product_id, model in expected_models.items():
            packed = (product_id << 24) | 0x00030201
            item = BRIDGE.frame(
                BRIDGE.ACK_BASE | 33,
                bytes((3, BRIDGE.PING, 7, 0))
                + packed.to_bytes(4, "little"),
            )
            decoded = self.service._decode(item)["data"]
            self.assertEqual(decoded["firmwareVersion"], "3.2.1")
            self.assertEqual(decoded["hardwareProductId"], product_id)
            self.assertEqual(decoded["hardwareModel"], model)


class MotionReplayTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.original_emit = BRIDGE.emit
        BRIDGE.emit = lambda event, data: self.events.append((event, data))
        self.service = BRIDGE.MotorService()
        self.transport = CapturingTransport()
        self.service.transport = self.transport
        self.service.connected = True
        self.service.node = 17

    def tearDown(self):
        BRIDGE.emit = self.original_emit

    @staticmethod
    def motion_params():
        return {
            "closed": False,
            "direction": 1,
            "count": 0x1234,
            "speedLevel": 10,
            "accelerationLevel": 20,
        }

    def test_motion_replay_reuses_exact_can_id_payload_and_sequence(self):
        first = self.service.move(self.motion_params())
        replayed = self.service.motion_replay({
            "replayId": first["replayId"],
        })

        self.assertEqual(len(self.transport.sent), 2)
        self.assertEqual(self.transport.sent[1], self.transport.sent[0])
        self.assertEqual(replayed["sequence"], first["sequence"])
        self.assertEqual(replayed["replayId"], first["replayId"])
        self.assertEqual(self.service.motion_sequence, 1)

    def test_servo_replay_uses_closed_id_format5_and_shared_sequence(self):
        relative = self.service.move(self.motion_params())
        servo = self.service.servo_move({
            "angle": 359,
            "speedLevel": 10,
            "accelerationLevel": 20,
        })
        replayed = self.service.motion_replay({
            "replayId": servo["replayId"],
        })

        self.assertEqual(relative["sequence"], 0)
        self.assertEqual(servo["sequence"], 1)
        self.assertEqual(servo["angle"], 359)
        self.assertEqual(self.transport.sent[1]["id"], BRIDGE.CLOSED_BASE | 17)
        self.assertEqual(
            self.transport.sent[1]["data"],
            bytes.fromhex("AA 67 01 00 0A 01 14 FF"),
        )
        self.assertEqual(self.transport.sent[2], self.transport.sent[1])
        self.assertEqual(replayed["sequence"], servo["sequence"])
        self.assertEqual(self.service.motion_sequence, 2)

    def test_zero_acceleration_encodes_immediate_relative_and_servo_frames(self):
        relative = self.service.move({
            **self.motion_params(),
            "accelerationLevel": 0,
        })
        servo = self.service.servo_move({
            "angle": 359,
            "speedLevel": 10,
            "accelerationLevel": 0,
        })

        self.assertEqual(relative["accelerationLevel"], 0)
        self.assertEqual(servo["accelerationLevel"], 0)
        self.assertEqual(
            self.transport.sent[0]["data"],
            bytes.fromhex("AD 34 12 00 0A 00 00 C5"),
        )
        self.assertEqual(
            self.transport.sent[1]["data"],
            bytes.fromhex("AA 67 01 00 0A 01 00 FF"),
        )

    def test_servo_validation_happens_before_allocating_sequence_or_sending(self):
        base = {
            "angle": 180,
            "speedLevel": 10,
            "accelerationLevel": 20,
        }
        for invalid in (
            {**base, "angle": -1},
            {**base, "angle": 360},
            {**base, "angle": True},
            {**base, "speedLevel": 0},
            {**base, "accelerationLevel": -1},
            {**base, "accelerationLevel": 101},
        ):
            with self.assertRaises(BRIDGE.RequestValidationError):
                self.service.servo_move(invalid)
        self.assertEqual(self.transport.sent, [])
        self.assertEqual(self.service.motion_sequence, 0)

        accepted = self.service.servo_move(base)
        self.assertEqual(accepted["sequence"], 0)
        self.assertEqual(len(self.transport.sent), 1)

    def test_relative_validation_rejects_speed_zero_and_bad_acceleration(self):
        base = self.motion_params()
        for invalid in (
            {**base, "speedLevel": 0},
            {**base, "accelerationLevel": -1},
            {**base, "accelerationLevel": 101},
        ):
            with self.assertRaises(BRIDGE.RequestValidationError):
                self.service.move(invalid)
        self.assertEqual(self.transport.sent, [])
        self.assertEqual(self.service.motion_sequence, 0)

    def test_expired_motion_replay_is_rejected_as_state_unknown(self):
        first = self.service.move(self.motion_params())
        self.service.motion_replays[first["replayId"]]["expiresAt"] = (
            time.monotonic() - 1
        )

        with self.assertRaisesRegex(RuntimeError, "执行状态不确定"):
            self.service.motion_replay({
                "replayId": first["replayId"],
            })
        self.assertEqual(len(self.transport.sent), 1)

    def test_motion_replay_is_pinned_to_original_node_after_default_changes(self):
        params = {**self.motion_params(), "nodeId": 17}
        first = self.service.move(params)
        self.service.set_node({"nodeId": 18})
        replayed = self.service.motion_replay({
            "replayId": first["replayId"],
        })

        self.assertEqual(replayed["nodeId"], 17)
        self.assertEqual(self.transport.sent[0]["id"], BRIDGE.OPEN_BASE | 17)
        self.assertEqual(self.transport.sent[1], self.transport.sent[0])


class MultiNodeServiceTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.original_emit = BRIDGE.emit
        BRIDGE.emit = lambda event, data: self.events.append((event, data))
        self.service = BRIDGE.MotorService()
        self.transport = CapturingTransport()
        self.service.transport = self.transport
        self.service.connected = True
        self.service.node = 17

    def tearDown(self):
        BRIDGE.emit = self.original_emit

    def test_addressed_controls_use_explicit_node_and_per_node_sequences(self):
        first_17 = self.service.ping({"nodeId": 17})
        first_18 = self.service.ping({"nodeId": 18})
        second_17 = self.service.status({"nodeId": 17, "flags": 3})

        self.assertEqual(first_17, {
            "sequence": 0, "broadcast": False, "nodeId": 17,
        })
        self.assertEqual(first_18, {
            "sequence": 0, "broadcast": False, "nodeId": 18,
        })
        self.assertEqual(second_17["sequence"], 1)
        self.assertEqual(
            [item["id"] for item in self.transport.sent],
            [
                BRIDGE.CONTROL_BASE | 17,
                BRIDGE.CONTROL_BASE | 18,
                BRIDGE.CONTROL_BASE | 17,
            ],
        )

    def test_status_many_deduplicates_nodes_and_sends_without_wait_state(self):
        result = self.service.status_many({
            "nodeIds": [17, 18, 17],
            "flags": 10,
        })

        self.assertEqual(result["nodeIds"], [17, 18])
        self.assertEqual(result["flags"], 10)
        self.assertEqual(result["requests"], [
            {"nodeId": 17, "sequence": 0},
            {"nodeId": 18, "sequence": 0},
        ])
        self.assertEqual(
            [item["id"] for item in self.transport.sent],
            [BRIDGE.CONTROL_BASE | 17, BRIDGE.CONTROL_BASE | 18],
        )
        self.assertEqual(
            [item["data"][2] for item in self.transport.sent],
            [10, 10],
        )

    def test_status_e_flag_is_accepted_and_unknown_bits_are_rejected(self):
        result = self.service.status({"nodeId": 17, "flags": 31})
        self.assertEqual(result["nodeId"], 17)
        self.assertEqual(self.transport.sent[-1]["data"][2], 31)
        with self.assertRaisesRegex(ValueError, "状态标志"):
            self.service.status({"nodeId": 17, "flags": 32})

    def test_status_many_rejects_an_unbounded_bus_burst(self):
        with self.assertRaisesRegex(ValueError, "单批状态请求最多"):
            self.service.status_many({
                "nodeIds": list(
                    range(1, BRIDGE.STATUS_MANY_MAX_NODES + 2)
                ),
                "flags": 15,
            })
        self.assertEqual(self.transport.sent, [])

    def test_parameter_correlation_includes_node_for_equal_sequences(self):
        request_17 = self.service.param_get({
            "nodeId": 17, "parameterId": 0x10,
        })
        request_18 = self.service.param_get({
            "nodeId": 18, "parameterId": 0x11,
        })
        self.assertEqual(request_17["sequence"], 0)
        self.assertEqual(request_18["sequence"], 0)
        self.assertEqual(
            {
                key: value[0]
                for key, value in self.service.pending_parameters.items()
            },
            {(17, 0): 0x10, (18, 0): 0x11},
        )

        decoded_18 = self.service._decode(
            BRIDGE.ack_frame(18, 4, BRIDGE.PARAM_GET, 0, 0, 32)
        )
        decoded_17 = self.service._decode(
            BRIDGE.ack_frame(17, 4, BRIDGE.PARAM_GET, 0, 0, 200)
        )
        self.assertEqual(decoded_18["data"]["parameterId"], 0x11)
        self.assertEqual(decoded_17["data"]["parameterId"], 0x10)
        self.assertEqual(self.service.pending_parameters, {})

    def test_parameter_correlation_expires_and_ack_carries_session(self):
        self.service.session_epoch = 42
        self.service.pending_parameters[(17, 9)] = (
            0x10,
            time.monotonic() - 0.1,
        )

        decoded = self.service._decode(
            BRIDGE.ack_frame(17, 4, BRIDGE.PARAM_GET, 9, 0, 200)
        )

        self.assertNotIn("parameterId", decoded["data"])
        self.assertEqual(decoded["data"]["sessionEpoch"], 42)
        self.assertEqual(self.service.pending_parameters, {})

    def test_broadcast_stop_targets_zero_and_addressed_stop_keeps_node(self):
        addressed = self.service.stop({
            "nodeId": 18, "immediate": True, "broadcast": False,
        })
        broadcast = self.service.stop({
            "nodeId": 18, "immediate": True, "broadcast": True,
        })

        self.assertEqual(addressed["nodeId"], 18)
        self.assertFalse(addressed["broadcast"])
        self.assertEqual(broadcast["nodeId"], 0)
        self.assertTrue(broadcast["broadcast"])
        self.assertEqual(
            [item["id"] for item in self.transport.sent],
            [BRIDGE.CONTROL_BASE | 18, BRIDGE.CONTROL_BASE],
        )

    def test_socketcan_filter_subscribes_to_all_response_node_groups(self):
        class FilterSocket:
            def __init__(self):
                self.option = None

            def setsockopt(self, level, option, value):
                self.option = (level, option, value)

        sock = FilterSocket()
        BRIDGE.SocketCanTransport._apply_filters(sock, 17)
        raw = sock.option[2]
        entries = [
            BRIDGE.FILTER.unpack(raw[offset:offset + BRIDGE.FILTER.size])
            for offset in range(0, len(raw), BRIDGE.FILTER.size)
        ]
        self.assertEqual(entries[:-1], [
            (BRIDGE.ACK_BASE, BRIDGE.NODE_GROUP_FILTER_MASK),
            (BRIDGE.STATUS_E_BASE, BRIDGE.NODE_GROUP_FILTER_MASK),
            (BRIDGE.STATUS_A_BASE, BRIDGE.NODE_GROUP_FILTER_MASK),
            (BRIDGE.STATUS_B_BASE, BRIDGE.NODE_GROUP_FILTER_MASK),
            (BRIDGE.STATUS_C_BASE, BRIDGE.NODE_GROUP_FILTER_MASK),
            (BRIDGE.STATUS_D_BASE, BRIDGE.NODE_GROUP_FILTER_MASK),
            (BRIDGE.FW_UPDATE_RESPONSE_BASE,
             BRIDGE.NODE_GROUP_FILTER_MASK),
        ])
        self.assertEqual(
            entries[-1],
            (BRIDGE.PAIR_RESPONSE, BRIDGE.EXACT_FILTER_MASK),
        )

    def test_frame_log_json_carries_addressed_or_broadcast_node(self):
        payload = bytes(8)
        self.assertEqual(
            BRIDGE.frame_json(
                BRIDGE.frame(BRIDGE.CONTROL_BASE | 18, payload), "tx"
            )["nodeId"],
            18,
        )
        self.assertEqual(
            BRIDGE.frame_json(
                BRIDGE.frame(BRIDGE.CONTROL_BASE, payload), "tx"
            )["nodeId"],
            0,
        )
        self.assertIsNone(
            BRIDGE.frame_json(
                BRIDGE.frame(BRIDGE.PAIR_RESPONSE, payload), "rx"
            )["nodeId"]
        )


class LevelProtocolTests(unittest.TestCase):
    def test_python_mapping_matches_format6_square_curve_and_clamps(self):
        nominal = BRIDGE.motion_rates_from_levels(10, 10, 200, 32)
        self.assertEqual(nominal["requestedSpeed"], 3200)
        self.assertEqual(nominal["requestedAcceleration"], 21333)
        self.assertEqual(nominal["actualSpeed"], 3200)
        self.assertEqual(nominal["actualAcceleration"], 21333)
        custom_limits = BRIDGE.motion_rates_from_levels(
            100, 100, 200, 32, 120, 300
        )
        self.assertEqual(custom_limits["actualSpeed"], 12800)
        self.assertEqual(custom_limits["actualAcceleration"], 32000)
        self.assertFalse(nominal["speedClamped"])
        self.assertFalse(nominal["accelerationClamped"])
        self.assertEqual(
            nominal["boundaries"],
            {"speed": 254000, "acceleration": 1500000},
        )

        clamped = BRIDGE.motion_rates_from_levels(100, 100, 2000, 256)
        self.assertEqual(clamped["actualSpeed"], 2046000)
        self.assertEqual(clamped["actualAcceleration"], 1500000)
        self.assertTrue(clamped["speedClamped"])
        self.assertTrue(clamped["accelerationClamped"])

        with self.assertRaises(ValueError):
            BRIDGE.motion_rates_from_levels(0, 1, 200, 32)
        for acceleration_level in (-1, 101):
            with self.assertRaises(ValueError):
                BRIDGE.motion_rates_from_levels(
                    1, acceleration_level, 200, 32
                )

    def test_python_mapping_exposes_zero_acceleration_bypass(self):
        rates = BRIDGE.motion_rates_from_levels(10, 0, 200, 32)
        self.assertTrue(rates["accelerationBypassed"])
        self.assertEqual(rates["requestedSpeed"], 3200)
        self.assertEqual(rates["actualSpeed"], 3200)
        self.assertIsNone(rates["requestedAcceleration"])
        self.assertIsNone(rates["actualAcceleration"])
        self.assertFalse(rates["accelerationClamped"])

    def test_simulator_decodes_level_frame_with_same_mapping(self):
        transport = BRIDGE.SimulatedTransport(
            lambda _frame: None,
            lambda *_error: None,
        )
        transport.connect("sim0", 17)
        frame = bytes.fromhex("AC 7B 00 00 0A 07 14 C5")
        responses = transport._motion(frame, closed=False)

        self.assertEqual(responses[0]["data"][3], 0)
        self.assertEqual(responses[0]["data"][2], 7)
        self.assertEqual(transport.last_speed_level, 10)
        self.assertEqual(transport.last_acceleration_level, 20)
        self.assertEqual(transport.last_actual_speed, 12800)
        self.assertEqual(transport.last_actual_acceleration, 341333)

        for invalid in (
            "00 7B 00 00 0A 07 14 C5",
            "0E 7B 00 00 0A 07 14 5A",
            "AC 7B 00 00 0A 07 14 00",
            "AC 00 00 00 0A 07 14 C5",
            "AC 7B 00 00 00 07 14 C5",
            "AC 7B 00 00 0A 07 65 C5",
        ):
            self.assertEqual(
                transport._motion(bytes.fromhex(invalid), closed=False),
                [],
            )

    def test_simulator_accepts_immediate_relative_and_servo_frames(self):
        transport = BRIDGE.SimulatedTransport(
            lambda _frame: None,
            lambda *_error: None,
        )
        transport.connect("sim0", 17)

        relative = bytes.fromhex("AC 7B 00 00 0A 07 00 C5")
        response = transport._motion(relative, closed=False)
        self.assertEqual(response[0]["data"][3], 0)
        self.assertEqual(transport.last_acceleration_level, 0)
        self.assertIsNone(transport.last_actual_acceleration)
        self.assertEqual(transport.motion_queue[0]["accelerationLevel"], 0)

        transport.calibration_valid = True
        servo = bytes.fromhex("AA 5A 00 00 0A 08 00 FF")
        response = transport._motion(servo, closed=True)
        self.assertEqual(response[0]["data"][3], 0)
        self.assertEqual(transport.last_acceleration_level, 0)
        self.assertIsNone(transport.last_actual_acceleration)
        self.assertEqual(transport.motion_queue[1]["kind"], "servo")
        self.assertEqual(transport.motion_queue[1]["accelerationLevel"], 0)


class Format6SimulationTests(unittest.TestCase):
    def setUp(self):
        self.transport = BRIDGE.SimulatedTransport(
            lambda _frame: None,
            lambda *_error: None,
        )
        self.transport.connect("sim0", 17)

    @staticmethod
    def control_frame(opcode, sequence=0, flags=0, argument=0):
        return bytes((opcode, sequence, flags, 0)) + argument.to_bytes(
            4,
            "little",
        )

    @staticmethod
    def parameter_frame(opcode, sequence, parameter_id, value=0):
        return bytes((opcode, sequence, parameter_id, 0)) + int(
            value
        ).to_bytes(4, "little", signed=True)

    def test_cascade_parameters_and_removed_ids_match_format6(self):
        self.assertEqual(self.transport.parameters[0x40], 2000)
        self.assertEqual(self.transport.parameters[0x41], 500)
        self.assertNotIn(0x42, self.transport.parameters)
        self.assertNotIn(0x43, self.transport.parameters)

        for parameter_id in (0x40, 0x41):
            response = self.transport._parameter(
                self.parameter_frame(BRIDGE.PARAM_GET, 1, parameter_id)
            )
            self.assertEqual(response[0]["data"][3], 0)

        for removed_id in (0x42, 0x43, 0x45, 0x46, 0x60):
            response = self.transport._parameter(
                self.parameter_frame(BRIDGE.PARAM_GET, 2, removed_id)
            )
            self.assertEqual(response[0]["data"][3], 5)

        open_hold = self.transport._parameter(
            self.parameter_frame(BRIDGE.PARAM_SET, 3, 0x33, 1)
        )
        self.assertEqual(open_hold[0]["data"][3], 0)
        closed_hold = self.transport._parameter(
            self.parameter_frame(BRIDGE.PARAM_SET, 4, 0x33, 2)
        )
        self.assertEqual(closed_hold[0]["data"][3], 0)
        invalid_hold = self.transport._parameter(
            self.parameter_frame(BRIDGE.PARAM_SET, 5, 0x33, 3)
        )
        self.assertEqual(invalid_hold[0]["data"][3], 5)

    def test_status_e_reports_present_and_active_limit_masks(self):
        self.transport.limit_switch_active_mask = 0x02
        status = self.transport._status_e()
        self.assertEqual(status["id"], BRIDGE.STATUS_E_BASE | 17)
        self.assertEqual(status["data"], bytes((3, 2, 2, 0, 1, 1, 10, 0)))

        decoded = BRIDGE.MotorService()._decode(status)
        self.assertEqual(decoded["event"], "status")
        self.assertEqual(decoded["data"]["part"], "E")
        self.assertEqual(decoded["data"]["nodeId"], 17)
        self.assertEqual(decoded["data"]["limitSwitchPresentMask"], 3)
        self.assertEqual(decoded["data"]["limitSwitchActiveMask"], 2)
        self.assertEqual(decoded["data"]["limitSwitchFormatVersion"], 2)
        self.assertTrue(decoded["data"]["homingSupported"])
        self.assertEqual(decoded["data"]["homingState"], 0)
        self.assertEqual(decoded["data"]["homingLimitSwitch"], 1)
        self.assertEqual(decoded["data"]["homingDirection"], 1)
        self.assertEqual(decoded["data"]["homingSpeedLevel"], 10)

        legacy = BRIDGE.MotorService()._decode(BRIDGE.frame(
            BRIDGE.STATUS_E_BASE | 17,
            bytes((3, 2, 1, 0, 0, 0, 0, 0)),
        ))
        self.assertFalse(legacy["data"]["homingSupported"])

    def test_status_e_rejects_impossible_or_noncanonical_payloads(self):
        service = BRIDGE.MotorService()
        for payload in (
            bytes((0x10, 0, 1, 0, 0, 0, 0, 0)),
            bytes((1, 2, 1, 0, 0, 0, 0, 0)),
            bytes((1, 0, 3, 0, 0, 0, 0, 0)),
            bytes((1, 0, 1, 1, 0, 0, 0, 0)),
            bytes((3, 0, 2, 5, 1, 1, 10, 0)),
            bytes((3, 0, 2, 0, 3, 1, 10, 0)),
            bytes((3, 0, 2, 0, 1, 2, 10, 0)),
            bytes((3, 0, 2, 0, 1, 1, 0, 0)),
            bytes((3, 0, 2, 0, 1, 1, 10, 1)),
        ):
            with self.subTest(payload=payload.hex()):
                with self.assertRaisesRegex(ValueError, "Status E"):
                    service._decode(BRIDGE.frame(
                        BRIDGE.STATUS_E_BASE | 17,
                        payload,
                    ))

    def test_homing_is_exclusive_and_selected_limit_zeros_position(self):
        self.transport.parameters[0x33] = 1
        self.transport.parameters[0x21] = 600
        start = self.transport._control(
            self.control_frame(BRIDGE.HOMING_START, sequence=20),
            broadcast=False,
        )
        self.assertEqual(start[0]["data"][3], 0)
        self.assertEqual(self.transport.homing_state, 1)
        self.assertEqual(self.transport.run_state, 11)

        motion = bytes.fromhex("AC 10 00 00 0A 21 00 C5")
        busy = self.transport._motion(motion, closed=False)
        self.assertEqual(busy[0]["data"][3], 8)

        self.transport.position = 1234
        self.transport.limit_switch_active_mask = 0x01
        self.transport._advance_homing()
        self.assertEqual(self.transport.homing_state, 2)
        self.assertEqual(self.transport.position, 0)
        self.assertEqual(self.transport.target, 0)
        self.assertEqual(self.transport.current_ma, 0)

    def test_homing_rejects_an_initial_nonselected_limit(self):
        self.transport.limit_switch_active_mask = 0x02
        response = self.transport._control(
            self.control_frame(BRIDGE.HOMING_START, sequence=25),
            broadcast=False,
        )
        self.assertEqual(response[0]["data"][3], 6)
        self.assertEqual(self.transport.homing_state, 4)
        self.assertEqual(self.transport.run_state, 2)
        self.assertEqual(self.transport.current_ma, 0)

    def test_homing_waits_for_fresh_encoder_before_zeroing_calibrated_axis(self):
        self.transport.calibration_valid = True
        self.transport.encoder_valid = False
        self.transport.position = 4321
        self.transport.limit_switch_active_mask = 0x01
        response = self.transport._control(
            self.control_frame(BRIDGE.HOMING_START, sequence=26),
            broadcast=False,
        )
        self.assertEqual(response[0]["data"][3], 0)
        self.assertEqual(response[0]["data"][4], 1)
        self.assertEqual(self.transport.homing_state, 1)
        self.assertEqual(self.transport.run_state, 11)
        self.assertEqual(self.transport.current_ma, 0)
        self.assertEqual(self.transport.position, 4321)

        self.transport._advance_homing()
        self.assertEqual(self.transport.homing_state, 1)
        self.transport.encoder_valid = True
        self.transport._advance_homing()
        self.assertEqual(self.transport.homing_state, 2)
        self.assertEqual(self.transport.position, 0)

    def test_homing_aborts_if_calibrated_encoder_does_not_recover(self):
        self.transport.calibration_valid = True
        self.transport.encoder_valid = False
        self.transport.limit_switch_active_mask = 0x01
        self.transport._control(
            self.control_frame(BRIDGE.HOMING_START, sequence=27),
            broadcast=False,
        )
        for _ in range(BRIDGE.SIM_HOMING_ENCODER_CAPTURE_POLLS):
            self.transport._advance_homing()
        self.assertEqual(self.transport.homing_state, 4)
        self.assertEqual(self.transport.current_ma, 0)
        self.assertEqual(self.transport.faults, 0)

    def test_homing_allows_reads_but_rejects_parameter_mutations(self):
        self.transport._control(
            self.control_frame(BRIDGE.HOMING_START, sequence=26),
            broadcast=False,
        )
        parameters_before = dict(self.transport.parameters)
        saved_before = dict(self.transport.saved)

        get_response = self.transport._parameter(
            self.parameter_frame(BRIDGE.PARAM_GET, 27, 0x4D)
        )
        self.assertEqual(get_response[0]["data"][3], 0)

        for sequence, opcode, parameter_id, value in (
            (28, BRIDGE.PARAM_SET, 0x4D, 99),
            (29, BRIDGE.PARAM_SAVE, 0, 0),
            (30, BRIDGE.PARAM_DEFAULTS, 0, 0),
        ):
            with self.subTest(opcode=opcode):
                response = self.transport._parameter(
                    self.parameter_frame(
                        opcode, sequence, parameter_id, value
                    )
                )
                self.assertEqual(response[0]["data"][3], 8)
                self.assertEqual(self.transport.parameters, parameters_before)
                self.assertEqual(self.transport.saved, saved_before)

    def test_homing_stop_wrong_limit_and_timeout_are_non_latching_results(self):
        self.transport._control(
            self.control_frame(BRIDGE.HOMING_START, sequence=30),
            broadcast=False,
        )
        self.transport._control(
            self.control_frame(BRIDGE.STOP, sequence=31),
            broadcast=False,
        )
        self.assertEqual(self.transport.homing_state, 4)
        self.assertEqual(self.transport.faults, 0)

        self.transport.homing_state = 1
        self.transport.limit_switch_active_mask = 0x03
        self.transport._advance_homing()
        self.assertEqual(self.transport.homing_state, 4)
        self.assertEqual(self.transport.faults, 0)

        self.transport.limit_switch_active_mask = 0
        self.transport.homing_state = 1
        self.transport.homing_polls = BRIDGE.SIM_HOMING_MAX_POLLS - 1
        self.transport._advance_homing()
        self.assertEqual(self.transport.homing_state, 3)
        self.assertEqual(self.transport.faults, 0)

    def test_get_status_all_includes_status_e(self):
        responses = self.transport._control(
            self.control_frame(BRIDGE.GET_STATUS, flags=BRIDGE.STATUS_ALL),
            broadcast=False,
        )
        self.assertEqual(
            [item["id"] & ~0x7F for item in responses[:-1]],
            [
                BRIDGE.STATUS_A_BASE,
                BRIDGE.STATUS_B_BASE,
                BRIDGE.STATUS_C_BASE,
                BRIDGE.STATUS_D_BASE,
                BRIDGE.STATUS_E_BASE,
            ],
        )

    def test_defaults_restore_verified_baseline_but_preserve_bus_identity(self):
        self.transport.parameters[0x02] = 500_000
        self.transport.parameters[0x11] = 32
        self.transport.parameters[0x20] = 123
        self.transport.calibration_valid = True

        response = self.transport._parameter(
            self.parameter_frame(BRIDGE.PARAM_DEFAULTS, 8, 0)
        )

        self.assertEqual(response[0]["data"][3], 0)
        expected = BRIDGE.default_parameters(17)
        expected[0x02] = 500_000
        self.assertEqual(self.transport.parameters, expected)
        self.assertEqual(self.transport.parameters[0x01], 17)
        self.assertEqual(self.transport.parameters[0x02], 500_000)
        self.assertFalse(self.transport.calibration_valid)

    def test_gearbox_parameter_boundaries_and_calibration_invalidation(self):
        self.assertEqual(
            self.transport.parameters[BRIDGE.PARAM_ENCODER_MOUNT_MODE],
            BRIDGE.ENCODER_MOUNT_MOTOR_SHAFT,
        )
        self.assertEqual(
            self.transport.parameters[BRIDGE.PARAM_GEAR_RATIO_NUM], 1
        )
        self.assertEqual(
            self.transport.parameters[BRIDGE.PARAM_GEAR_RATIO_DEN], 1
        )

        self.transport.calibration_valid = True
        accepted_num = self.transport._parameter(self.parameter_frame(
            BRIDGE.PARAM_SET, 30, BRIDGE.PARAM_GEAR_RATIO_NUM, 1000
        ))
        self.assertEqual(accepted_num[0]["data"][3], 0)
        self.assertTrue(self.transport.calibration_valid)
        accepted_den = self.transport._parameter(self.parameter_frame(
            BRIDGE.PARAM_SET, 31, BRIDGE.PARAM_GEAR_RATIO_DEN, 1000
        ))
        self.assertEqual(accepted_den[0]["data"][3], 0)
        self.assertTrue(self.transport.calibration_valid)
        accepted_mode = self.transport._parameter(self.parameter_frame(
            BRIDGE.PARAM_SET,
            32,
            BRIDGE.PARAM_ENCODER_MOUNT_MODE,
            BRIDGE.ENCODER_MOUNT_GEARBOX_OUTPUT,
        ))
        self.assertEqual(accepted_mode[0]["data"][3], 0)
        self.assertFalse(self.transport.calibration_valid)
        self.transport.calibration_valid = True
        changed_active_ratio = self.transport._parameter(
            self.parameter_frame(
                BRIDGE.PARAM_SET, 33, BRIDGE.PARAM_GEAR_RATIO_DEN, 999
            )
        )
        self.assertEqual(changed_active_ratio[0]["data"][3], 0)
        self.assertFalse(self.transport.calibration_valid)

        for sequence, parameter_id, value in (
            (40, BRIDGE.PARAM_ENCODER_MOUNT_MODE, -1),
            (41, BRIDGE.PARAM_ENCODER_MOUNT_MODE, 2),
            (42, BRIDGE.PARAM_GEAR_RATIO_NUM, 0),
            (43, BRIDGE.PARAM_GEAR_RATIO_NUM, 1001),
            (44, BRIDGE.PARAM_GEAR_RATIO_DEN, 0),
            (45, BRIDGE.PARAM_GEAR_RATIO_DEN, 1001),
            # The candidate 998/999 ratio is not a reduction.
            (46, BRIDGE.PARAM_GEAR_RATIO_NUM, 998),
        ):
            response = self.transport._parameter(self.parameter_frame(
                BRIDGE.PARAM_SET, sequence, parameter_id, value
            ))
            self.assertEqual(response[0]["data"][3], 5)

    def test_output_encoder_non_integer_ratio_uses_output_shortest_path(self):
        self.transport.parameters[BRIDGE.PARAM_GEAR_RATIO_NUM] = 47
        self.transport.parameters[BRIDGE.PARAM_GEAR_RATIO_DEN] = 3
        self.transport.parameters[BRIDGE.PARAM_ENCODER_MOUNT_MODE] = (
            BRIDGE.ENCODER_MOUNT_GEARBOX_OUTPUT
        )
        self.transport.calibration_valid = True
        # 399953 motor microsteps is approximately 359.0004 output degrees.
        self.transport.position = 399_953
        self.transport.target = self.transport.position
        servo_zero = bytes.fromhex("AA 00 00 00 0A 37 14 FF")
        response = self.transport._motion(servo_zero, closed=True)

        self.assertEqual(response[0]["data"][3], 0)
        self.assertEqual(self.transport.target, 401_067)
        self.assertEqual(self.transport.target - self.transport.position, 1114)
        self.assertEqual(
            int.from_bytes(
                self.transport._status_d()["data"][4:8],
                "little",
                signed=True,
            ),
            1114,
        )
        self.assertEqual(
            int.from_bytes(self.transport._status_c()["data"][4:6], "little"),
            16_338,
        )

        self.transport._clear_motion_queue()
        self.transport.motion_ack_cache.clear()
        self.transport.position = 0
        servo_half_turn = bytes.fromhex("AA B4 00 00 0A 38 14 FF")
        self.transport._motion(servo_half_turn, closed=True)
        self.assertEqual(self.transport.target, 200_533)

    def test_terminal_hold_only_matches_the_completed_motion_mode(self):
        self.transport.calibration_valid = True
        self.transport.parameters[0x21] = 321
        cases = (
            (0, False, 2, False, 0),
            (0, True, 2, False, 0),
            (1, False, 6, False, 321),
            (1, True, 2, False, 0),
            (2, False, 2, False, 0),
            (2, True, 6, True, 321),
        )
        for sequence, (
            hold_mode,
            motion_closed,
            expected_run_state,
            expected_closed,
            expected_current,
        ) in enumerate(cases, start=20):
            with self.subTest(
                hold_mode=hold_mode, motion_closed=motion_closed
            ):
                self.transport._clear_motion_queue()
                self.transport.motion_ack_cache.clear()
                self.transport.parameters[0x33] = hold_mode
                motion = bytes((
                    0xAC, 0x01, 0x00, 0x00,
                    10, sequence, 10, 0xC5,
                ))
                accepted = self.transport._motion(
                    motion, closed=motion_closed
                )
                self.assertEqual(accepted[0]["data"][3], 0)
                self.transport._advance_motion()
                self.assertEqual(
                    self.transport.run_state, expected_run_state
                )
                self.assertEqual(
                    self.transport.closed, expected_closed
                )
                self.assertEqual(
                    self.transport.current_ma, expected_current
                )

    def test_settle_tolerance_matches_firmware_range(self):
        for sequence, value in enumerate((1, 4096), start=10):
            response = self.transport._parameter(
                self.parameter_frame(
                    BRIDGE.PARAM_SET,
                    sequence,
                    0x44,
                    value,
                )
            )
            self.assertEqual(response[0]["data"][3], 0)
            self.assertEqual(self.transport.parameters[0x44], value)

        for sequence, value in enumerate((0, 4097), start=20):
            response = self.transport._parameter(
                self.parameter_frame(
                    BRIDGE.PARAM_SET,
                    sequence,
                    0x44,
                    value,
                )
            )
            self.assertEqual(response[0]["data"][3], 5)

    def test_encoder_calibration_sets_zero_and_position_lock_is_explicit(self):
        self.transport.position = 1234
        self.transport.target = 1234
        started = self.transport._control(
            self.control_frame(BRIDGE.CAL_START, argument=250),
            broadcast=False,
        )
        self.assertEqual(started[0]["data"][3], 0)
        self.assertTrue(self.transport.calibration_valid)
        self.assertEqual(self.transport.calibration_state, 11)
        self.assertEqual(self.transport.position, 0)
        self.assertEqual(self.transport.target, 0)
        self.transport.parameters[0x20] = 0
        self.transport.parameters[0x21] = 321

        locked = self.transport._control(
            self.control_frame(BRIDGE.POSITION_LOCK, sequence=1),
            broadcast=False,
        )
        self.assertEqual(locked[0]["data"][3], 0)
        self.assertTrue(self.transport.position_lock_active)
        self.assertEqual(self.transport.run_state, 6)
        self.assertEqual(self.transport.current_ma, 321)
        self.assertTrue(self.transport._status_a()["data"][2] & (1 << 7))

        malformed_unlock = self.transport._control(
            self.control_frame(
                BRIDGE.POSITION_UNLOCK,
                sequence=2,
                argument=1,
            ),
            broadcast=False,
        )
        self.assertEqual(malformed_unlock[0]["data"][3], 4)
        self.assertTrue(self.transport.position_lock_active)

        unlocked = self.transport._control(
            self.control_frame(BRIDGE.POSITION_UNLOCK, sequence=3),
            broadcast=False,
        )
        self.assertEqual(unlocked[0]["data"][3], 0)
        self.assertFalse(self.transport.position_lock_active)

        aborted = self.transport._control(
            self.control_frame(BRIDGE.CAL_ABORT, sequence=4),
            broadcast=False,
        )
        self.assertEqual(aborted[0]["data"][3], 0)
        self.assertEqual(self.transport.calibration_state, 0)

        unsupported = self.transport._control(
            self.control_frame(0x08, sequence=5),
            broadcast=False,
        )
        self.assertEqual(unsupported[0]["data"][3], 3)

    def test_motion_retry_sequence_conflict_and_cancel_tombstone(self):
        first = bytes.fromhex("AC 7B 00 00 0A FF 14 C5")
        same_sequence_other_payload = bytes.fromhex(
            "AC 7C 00 00 0A FF 14 C5"
        )

        accepted = self.transport._motion(first, closed=False)[0]["data"]
        retried = self.transport._motion(first, closed=False)[0]["data"]
        conflicted = self.transport._motion(
            same_sequence_other_payload,
            closed=False,
        )[0]["data"]

        self.assertEqual(accepted[3], 0)
        self.assertEqual(int.from_bytes(accepted[4:8], "little"), 1)
        self.assertEqual(retried, accepted)
        self.assertEqual(conflicted[3], 8)
        self.assertEqual(len(self.transport.motion_queue), 1)
        self.assertEqual(self.transport.run_state, 3)

        self.transport._advance_motion()
        conflict_retry = self.transport._motion(
            same_sequence_other_payload,
            closed=False,
        )[0]["data"]
        self.assertEqual(conflict_retry, conflicted)
        self.assertEqual(len(self.transport.motion_queue), 0)

        cancelled = bytes.fromhex("AC 7D 00 00 0A FE 14 C5")
        self.transport._motion(cancelled, closed=False)
        self.transport._control(
            self.control_frame(BRIDGE.STOP),
            broadcast=False,
        )
        cancelled_retry = self.transport._motion(
            cancelled, closed=False
        )[0]["data"]
        self.assertEqual(cancelled_retry[3], 6)
        self.assertEqual(len(self.transport.motion_queue), 0)

        rejected_closed = bytes.fromhex(
            "AC 7B 00 00 0A 02 14 C5"
        )
        not_calibrated = self.transport._motion(
            rejected_closed, closed=True
        )[0]["data"]
        self.assertEqual(not_calibrated[3], 6)
        self.transport.calibration_valid = True
        self.assertEqual(
            self.transport._motion(
                rejected_closed, closed=True
            )[0]["data"],
            not_calibrated,
        )

        closed = bytes.fromhex("AC 7B 00 00 0A 01 14 C5")
        self.assertEqual(
            self.transport._motion(closed, closed=True)[0]["data"][3],
            0,
        )
        self.assertEqual(self.transport.run_state, 5)

    def test_servo_format5_uses_shortest_path_and_predicts_mixed_fifo(self):
        self.transport.calibration_valid = True
        servo_180 = bytes.fromhex("AA B4 00 00 0A 00 14 FF")
        relative_negative = bytes.fromhex("AD E8 03 00 0A 01 14 C5")
        servo_90 = bytes.fromhex("AA 5A 00 00 0A 02 14 FF")

        accepted = self.transport._motion(
            servo_180, closed=True
        )[0]["data"]
        self.assertEqual(accepted[0:4], bytes((2, 0, 0, 0)))
        self.assertEqual(self.transport.target, 12_800)
        self.assertEqual(self.transport.run_state, 5)

        self.assertEqual(
            self.transport._motion(
                relative_negative, closed=False
            )[0]["data"][3],
            0,
        )
        self.assertEqual(
            self.transport._motion(
                servo_90, closed=True
            )[0]["data"][3],
            0,
        )
        status = self.transport._status_d()
        self.assertEqual(
            int.from_bytes(status["data"][4:8], "little", signed=True),
            6_400,
        )

        self.transport._advance_motion()
        self.assertEqual(self.transport.position, 12_800)
        self.assertEqual(self.transport.target, 11_800)
        status_after_first = self.transport._status_d()
        self.assertEqual(
            int.from_bytes(
                status_after_first["data"][4:8],
                "little",
                signed=True,
            ),
            -6_400,
        )
        self.transport._advance_motion()
        self.assertEqual(self.transport.target, 6_400)
        self.transport._advance_motion()
        self.assertEqual(self.transport.position, 6_400)
        self.assertEqual(
            int.from_bytes(
                self.transport._status_c()["data"][4:6],
                "little",
            ),
            4_096,
        )

    def test_servo_format5_rejects_open_or_malformed_frames(self):
        self.transport.calibration_valid = True
        valid = bytes.fromhex("AA 67 01 00 0A 07 14 FF")
        self.assertEqual(self.transport._motion(valid, closed=False), [])
        for invalid in (
            "AA 68 01 00 0A 07 14 FF",
            "AA 67 01 01 0A 07 14 FF",
            "AA 67 01 00 00 07 14 FF",
            "AA 67 01 00 0A 07 65 FF",
            "AA 67 01 00 0A 07 14 C5",
        ):
            self.assertEqual(
                self.transport._motion(
                    bytes.fromhex(invalid), closed=True
                ),
                [],
            )

    def test_motion_retry_identity_includes_can_id_and_fault_is_invalid_state(
        self,
    ):
        request = bytes.fromhex("AC 7B 00 00 0A 33 14 C5")
        self.assertEqual(
            self.transport._motion(request, closed=False)[0]["data"][3],
            0,
        )
        self.transport._advance_motion()

        self.transport.node = 18
        self.assertEqual(
            self.transport._motion(request, closed=False)[0]["data"][3],
            0,
        )
        self.assertEqual(len(self.transport.motion_queue), 1)

        faulted = BRIDGE.SimulatedTransport(
            lambda _frame: None,
            lambda *_error: None,
        )
        faulted.connect("sim0", 17)
        faulted.faults = 1 << 8
        fault_response = faulted._motion(
            bytes.fromhex("AC 7B 00 00 0A 34 14 C5"),
            closed=False,
        )[0]["data"]
        self.assertEqual(fault_response[3], 6)

    def test_status_d_relative_remaining_is_signed_little_endian(self):
        self.assertEqual(self.transport.motion_capacity, 64)
        self.transport.motion_queue = [{
            "closed": False,
            "direction": -1,
            "count": 0x01020304,
            "sequence": 0xA7,
            "speedLevel": 10,
            "accelerationLevel": 20,
        }]
        status = self.transport._status_d()
        self.assertEqual(status["data"][4:8], bytes.fromhex("FC FC FD FE"))

        decoded = BRIDGE.MotorService()._decode(status)
        self.assertEqual(decoded["data"]["part"], "D")
        self.assertEqual(decoded["data"]["activeSequence"], 0xA7)
        self.assertEqual(decoded["data"]["relativeRemaining"], -0x01020304)

        self.transport.motion_queue[0]["sequence"] = 0xFF
        active_ff = BRIDGE.MotorService()._decode(
            self.transport._status_d()
        )
        self.assertEqual(active_ff["data"]["activeSequence"], 0xFF)

        self.transport.motion_queue = []
        inactive_ff = BRIDGE.MotorService()._decode(
            self.transport._status_d()
        )
        self.assertIsNone(inactive_ff["data"]["activeSequence"])

    def test_fifo_accepts_64_actions_and_rejects_the_65th(self):
        for index in range(64):
            payload = bytearray.fromhex("AC 01 00 00 0A 00 14 C5")
            payload[1:4] = (index + 1).to_bytes(3, "little")
            payload[5] = index
            response = self.transport._motion(
                bytes(payload),
                closed=False,
            )[0]["data"]
            self.assertEqual(response[3], 0, index)
            self.assertEqual(
                int.from_bytes(response[4:8], "little"),
                index + 1,
            )

        overflow = bytes.fromhex("AC 41 00 00 0A 40 14 C5")
        response = self.transport._motion(
            overflow,
            closed=False,
        )[0]["data"]
        self.assertEqual(response[3], 8)
        self.assertEqual(int.from_bytes(response[4:8], "little"), 64)
        self.assertEqual(len(self.transport.motion_queue), 64)

    def test_status_c_uses_position_error_name(self):
        decoded = BRIDGE.MotorService()._decode(
            self.transport._status_c()
        )
        self.assertEqual(decoded["data"]["positionError"], 0)
        self.assertNotIn("followingError", decoded["data"])

        self.transport.faults = 1 << 8
        reserved_fault = BRIDGE.MotorService()._decode(
            self.transport._status_a()
        )
        self.assertEqual(reserved_fault["data"]["faultFlags"], 1 << 8)
        self.assertEqual(reserved_fault["data"]["faultNames"], [])


if __name__ == "__main__":
    unittest.main()
