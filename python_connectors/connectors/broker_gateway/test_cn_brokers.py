from __future__ import annotations

import unittest
from unittest.mock import patch

from connectors.broker_gateway import eastmoney_emt, supermind


class SuperMindHelpersTest(unittest.TestCase):
    def test_status_normalization(self) -> None:
        self.assertEqual(supermind._status("全部成交"), "filled")
        self.assertEqual(supermind._status("部分成交"), "partially_filled")
        self.assertEqual(supermind._status("已撤"), "cancelled")
        self.assertEqual(supermind._status("废单"), "rejected")

    def test_account_is_required(self) -> None:
        with self.assertRaises(ValueError):
            supermind._resolve_account_id({})

    def test_submit_and_positions_follow_trade_api_contract(self) -> None:
        class FakeTradeApi:
            positions = {
                "600519.SH": {
                    "symbol": "600519.SH",
                    "amount": 100,
                    "cost_basis": 1500,
                }
            }

            def __init__(self) -> None:
                self.order_kwargs: dict[str, object] = {}

            def order(self, **kwargs: object) -> dict[str, object]:
                self.order_kwargs = kwargs
                return {"order_id": "order-1", "status": "已报"}

        fake = FakeTradeApi()
        original_api = supermind._api
        original_account_id = supermind._account_id
        try:
            supermind._api = fake
            supermind._account_id = "account-1"
            order = supermind.submit_order(
                "600519.SH",
                "buy",
                100,
                0,
                "market",
                False,
                {"accountId": "account-1"},
            )
            self.assertEqual(order["brokerOrderId"], "order-1")
            self.assertEqual(fake.order_kwargs, {"symbol": "600519.SH", "amount": 100})
            positions = supermind.get_positions(False, {"accountId": "account-1"})
            self.assertEqual(positions["positions"][0]["symbol"], "600519.SH")
            self.assertEqual(positions["positions"][0]["avgPrice"], 1500)
        finally:
            supermind._api = original_api
            supermind._account_id = original_account_id


class EastmoneyHelpersTest(unittest.TestCase):
    def test_connection_setting_merges_gateway_defaults(self) -> None:
        resolved = eastmoney_emt._connection_setting(
            {"connectionSetting": {"账号": "10001"}},
            {"账号": "", "密码": ""},
        )
        self.assertEqual(resolved, {"账号": "10001", "密码": ""})

    def test_connection_setting_is_required(self) -> None:
        with self.assertRaises(ValueError):
            eastmoney_emt._connection_setting({}, {})

    def test_connection_setting_can_come_from_environment(self) -> None:
        with patch.dict("os.environ", {"QUBIT_EMT_TEST": '{"账号":"10001"}'}):
            resolved = eastmoney_emt._connection_setting(
                {"connectionSettingEnv": "QUBIT_EMT_TEST"},
                {"账号": "", "密码": ""},
            )
        self.assertEqual(resolved, {"账号": "10001", "密码": ""})


if __name__ == "__main__":
    unittest.main()
