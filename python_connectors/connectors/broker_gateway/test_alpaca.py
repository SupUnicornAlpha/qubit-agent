"""
Alpaca adapter unit tests.

Run:
  cd python_connectors
  python -m unittest connectors.broker_gateway.test_alpaca -v

不依赖真实 Alpaca 账号；mock requests.request 拦截所有 HTTP。
"""

from __future__ import annotations

import sys
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

# 确保 python_connectors 在 sys.path
import os
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from connectors.broker_gateway import alpaca  # noqa: E402


def _resp(status: int, body: Any) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.json.return_value = body
    return m


class AlpacaHealthCheckTest(unittest.TestCase):
    def test_simulated_when_no_credentials(self) -> None:
        """缺 key 时降级 simulated healthy（不报错，便于本地无 key 开发）。"""
        # 清掉 env，确保 _resolve_credentials 返回空串
        with patch.dict(os.environ, {"ALPACA_API_KEY_ID": "", "ALPACA_API_SECRET": ""}, clear=False):
            r = alpaca.healthcheck({})
        self.assertTrue(r["healthy"])
        self.assertTrue(r.get("simulated"))

    def test_healthy_when_account_ok(self) -> None:
        with patch.dict(os.environ, {"ALPACA_API_KEY_ID": "kid", "ALPACA_API_SECRET": "sec"}):
            with patch("requests.request") as m_req:
                m_req.return_value = _resp(200, {"status": "ACTIVE", "buying_power": "12345.67", "cash": "999.99"})
                r = alpaca.healthcheck({"paper": True})
        self.assertTrue(r["healthy"])
        self.assertEqual(r["account_status"], "ACTIVE")
        self.assertEqual(r["buying_power"], "12345.67")

    def test_unhealthy_on_4xx(self) -> None:
        with patch.dict(os.environ, {"ALPACA_API_KEY_ID": "kid", "ALPACA_API_SECRET": "sec"}):
            with patch("requests.request") as m_req:
                m_req.return_value = _resp(401, {"message": "unauthorized"})
                r = alpaca.healthcheck({"paper": True})
        self.assertFalse(r["healthy"])
        self.assertIn("401", r["message"])


class AlpacaSubmitOrderTest(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["ALPACA_API_KEY_ID"] = "kid"
        os.environ["ALPACA_API_SECRET"] = "sec"

    def test_submit_limit_order_filled(self) -> None:
        body = {
            "id": "ord-abc-123",
            "status": "filled",
            "filled_qty": "5",
            "filled_avg_price": "189.42",
        }
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, body)
            r = alpaca.submit_order("AAPL", "buy", 5, 189.5, "limit", paper=True, cfg={})
        # 检查 HTTP 调用
        args, kwargs = m_req.call_args
        self.assertEqual(args[0], "POST")
        self.assertIn("/v2/orders", args[1])
        payload = kwargs["json"]
        self.assertEqual(payload["symbol"], "AAPL")
        self.assertEqual(payload["side"], "buy")
        self.assertEqual(payload["type"], "limit")
        self.assertEqual(payload["limit_price"], "189.5")
        # 检查返回
        self.assertEqual(r["brokerOrderId"], "ord-abc-123")
        self.assertEqual(r["status"], "filled")
        self.assertEqual(r["actualQuantity"], 5.0)
        self.assertEqual(r["actualPrice"], 189.42)

    def test_submit_market_order_no_limit_price(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, {"id": "ord-2", "status": "accepted", "filled_qty": "0"})
            r = alpaca.submit_order("TSLA", "sell", 1, 0.0, "market", paper=True, cfg={})
        payload = m_req.call_args.kwargs["json"]
        self.assertEqual(payload["type"], "market")
        self.assertNotIn("limit_price", payload)
        self.assertEqual(r["status"], "submitted")  # "accepted" → submitted via _map_status

    def test_submit_rejected_on_http_error(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(403, {"message": "forbidden"})
            r = alpaca.submit_order("AAPL", "buy", 1, 100, "limit", paper=True, cfg={})
        self.assertEqual(r["status"], "rejected")
        self.assertEqual(r["brokerOrderId"], "")

    def test_submit_uses_paper_base_url_by_default(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, {"id": "x", "status": "filled", "filled_qty": "1", "filled_avg_price": "1.0"})
            alpaca.submit_order("AAPL", "buy", 1, 100, "limit", paper=True, cfg={})
        url = m_req.call_args.args[1]
        self.assertTrue(url.startswith("https://paper-api.alpaca.markets"))

    def test_submit_uses_live_base_url_when_paper_false(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, {"id": "x", "status": "filled", "filled_qty": "1", "filled_avg_price": "1.0"})
            alpaca.submit_order("AAPL", "buy", 1, 100, "limit", paper=False, cfg={})
        url = m_req.call_args.args[1]
        self.assertTrue(url.startswith("https://api.alpaca.markets"))

    def test_submit_respects_explicit_baseUrl(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, {"id": "x", "status": "filled", "filled_qty": "1", "filled_avg_price": "1.0"})
            alpaca.submit_order("AAPL", "buy", 1, 100, "limit", paper=True, cfg={"baseUrl": "https://example.com/api"})
        url = m_req.call_args.args[1]
        self.assertTrue(url.startswith("https://example.com/api"))


class AlpacaCancelGetFillsPositionsTest(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["ALPACA_API_KEY_ID"] = "kid"
        os.environ["ALPACA_API_SECRET"] = "sec"

    def test_cancel_order_ok(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(204, "")
            r = alpaca.cancel_order("ord-xyz", paper=True, cfg={})
        args, _ = m_req.call_args
        self.assertEqual(args[0], "DELETE")
        self.assertIn("/v2/orders/ord-xyz", args[1])
        self.assertTrue(r["ok"])

    def test_get_order_filled(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, {
                "id": "ord-1",
                "status": "filled",
                "filled_qty": "10",
                "filled_avg_price": "50.25",
            })
            r = alpaca.get_order("ord-1", paper=True, cfg={})
        self.assertEqual(r["brokerOrderId"], "ord-1")
        self.assertEqual(r["status"], "filled")
        self.assertEqual(r["actualPrice"], 50.25)
        self.assertEqual(r["actualQuantity"], 10.0)

    def test_get_fills_from_order(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, {
                "id": "ord-1",
                "status": "filled",
                "filled_qty": "3",
                "filled_avg_price": "200",
            })
            r = alpaca.get_fills("ord-1", paper=True, cfg={})
        self.assertEqual(len(r["fills"]), 1)
        self.assertEqual(r["fills"][0]["fillQty"], 3.0)
        self.assertEqual(r["fills"][0]["fillPrice"], 200.0)

    def test_get_fills_empty_when_not_filled(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, {"id": "ord-1", "status": "new", "filled_qty": "0"})
            r = alpaca.get_fills("ord-1", paper=True, cfg={})
        self.assertEqual(r["fills"], [])

    def test_get_positions(self) -> None:
        with patch("requests.request") as m_req:
            m_req.return_value = _resp(200, [
                {"symbol": "AAPL", "qty": "10", "avg_entry_price": "180.5"},
                {"symbol": "NVDA", "qty": "-5", "avg_entry_price": "900"},
            ])
            r = alpaca.get_positions(paper=True, cfg={})
        self.assertEqual(len(r["positions"]), 2)
        self.assertEqual(r["positions"][0]["symbol"], "AAPL")
        self.assertEqual(r["positions"][0]["qty"], 10.0)
        self.assertEqual(r["positions"][1]["qty"], -5.0)


class AlpacaStatusMapTest(unittest.TestCase):
    def test_status_mapping(self) -> None:
        self.assertEqual(alpaca._map_status("filled"), "filled")
        self.assertEqual(alpaca._map_status("FILLED"), "filled")
        self.assertEqual(alpaca._map_status("canceled"), "cancelled")
        self.assertEqual(alpaca._map_status("cancelled"), "cancelled")
        self.assertEqual(alpaca._map_status("expired"), "cancelled")
        self.assertEqual(alpaca._map_status("rejected"), "rejected")
        self.assertEqual(alpaca._map_status("new"), "submitted")
        self.assertEqual(alpaca._map_status("accepted"), "submitted")
        self.assertEqual(alpaca._map_status("partially_filled"), "submitted")


class AlpacaTickerNormalizeTest(unittest.TestCase):
    def test_ticker_to_symbol(self) -> None:
        self.assertEqual(alpaca._ticker_to_symbol("AAPL"), "AAPL")
        self.assertEqual(alpaca._ticker_to_symbol("AAPL.US"), "AAPL")
        self.assertEqual(alpaca._ticker_to_symbol("nvda"), "NVDA")


if __name__ == "__main__":
    unittest.main()
