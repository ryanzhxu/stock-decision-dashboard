import os
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pandas as pd

import server


class ServerAvailabilityTests(unittest.TestCase):
    def test_full_requested_refresh_batches_every_ticker_including_new_symbols(self):
        tickers = ["AAPL", "AMD", "TSM", "NVDA", "QQQ"]
        calls = []

        def fake_payload(batch, **kwargs):
            calls.append((list(batch), kwargs))
            return {
                "refresh_status": {
                    "success_count": len(batch),
                    "failed_count": 0,
                    "cache_fallback_count": 0,
                    "last_dashboard_refresh": "2026-08-19T21:40:00Z",
                },
            }

        with patch.object(server, "MARKET_DATA_MAX_LIVE_TICKERS", 2), patch.object(server, "build_market_data_payload", side_effect=fake_payload):
            summary = server._refresh_market_cache_for_tickers(tickers, reason="test_full_requested_refresh")

        self.assertTrue(summary["completed"])
        self.assertEqual([batch for batch, _ in calls], [["AAPL", "AMD"], ["TSM", "NVDA"], ["QQQ"]])
        self.assertEqual(summary["requested_tickers"], tickers)
        self.assertEqual(summary["success_count"], len(tickers))
        self.assertTrue(all(kwargs["force"] is True and kwargs["auto_refresh"] is True for _, kwargs in calls))
        self.assertEqual([kwargs["refresh_market_context"] for _, kwargs in calls], [True, False, False])

    def test_full_refresh_route_returns_cache_snapshot_after_all_live_batches(self):
        full_summary = {
            "completed": True,
            "batch_count": 2,
            "requested_tickers": ["AAPL", "TSM", "NVDA"],
            "success_count": 3,
            "failed_count": 0,
            "cache_fallback_count": 0,
        }
        final_payload = {
            "success": True,
            "items": [{"ticker": "AAPL", "price": 1}, {"ticker": "TSM", "price": 2}, {"ticker": "NVDA", "price": 3}],
            "refresh_status": {},
        }
        with patch.object(server, "_refresh_market_cache_for_tickers", return_value=full_summary) as refresh, patch.object(server, "build_market_data_payload", return_value=final_payload) as payload_builder:
            response = server.app.test_client().get("/api/market-data?tickers=AAPL,TSM,NVDA&force=true&full_refresh=true")

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        refresh.assert_called_once_with(["AAPL", "TSM", "NVDA"], reason="api_full_refresh")
        payload_builder.assert_called_once_with(
            ["AAPL", "TSM", "NVDA"],
            force=False,
            auto_refresh=False,
            cache_only=True,
            refresh_market_context=False,
        )
        self.assertTrue(body["refresh_status"]["is_full_watchlist_refresh"])
        self.assertTrue(body["refresh_status"]["full_refresh_completed"])
        self.assertEqual(body["refresh_status"]["full_refresh_requested_tickers"], ["AAPL", "TSM", "NVDA"])

    def test_force_auto_refresh_bypasses_a_fresh_quote_cache(self):
        cached = {"cache_age_seconds": 1, "quote": {"price": 100.0, "history": {}}}
        live_quote = {
            "ticker": "TSM",
            "price": 200.0,
            "updatedAt": "2026-08-19T21:40:00Z",
            "cache_updated_at": "2026-08-19T21:40:00Z",
            "quote_status": "available",
            "quote_source": "yfinance",
            "history": {},
        }
        market_context = {"macro": {}, "market_context": {"vix": {"value": 19.5}, "equity_trend": {"spy": {}, "qqq": {}}}}
        with patch.object(server, "read_market_cache", return_value=cached), patch.object(server, "is_market_cache_fresh", return_value=True), patch.object(server, "fetch_market_quote_for_ticker", return_value=(live_quote, None, False, [{"source": "yfinance", "success": True}])) as fetch_quote, patch.object(server, "get_market_context_cached_snapshot", return_value=(market_context, {"status": "available", "cache_used": False, "cache_updated_at": "2026-08-19T21:40:00Z"})):
            payload = server.build_market_data_payload(["TSM"], force=True, auto_refresh=True, cache_only=False)

        fetch_quote.assert_called_once_with("TSM", True)
        self.assertEqual(payload["quotes"]["TSM"]["price"], 200.0)

    def test_dashboard_payload_returns_market_data_without_a_score_placeholder(self):
        original = server.get_market_context_cached_snapshot
        try:
            fixture = {
                "macro": {},
                "market_context": {
                    "vix": {"value": 19.5},
                    "equity_trend": {"spy": {}, "qqq": {}},
                },
            }
            calls = []

            def market_data(*args, **kwargs):
                calls.append((args, kwargs))
                return fixture, {"status": "available", "cache_used": False, "cache_updated_at": None}

            server.get_market_context_cached_snapshot = market_data
            payload = server.build_market_data_payload(["META"], cache_only=True)

            self.assertEqual(len(calls), 1)
            self.assertIs(payload["marketContext"], fixture)
            self.assertEqual(payload["market_context"]["vix"]["value"], 19.5)
            self.assertNotIn("score", payload["market_context"])
            self.assertNotIn("confidence", payload["market_context"])
        finally:
            server.get_market_context_cached_snapshot = original

    def test_old_intraday_lookback_cache_is_refreshed(self):
        old_cache = {
            "cache_age_seconds": 0,
            "quote": {"history": {"intervals": {
                "1h": {"lookback": "30d"},
                "4h": {"lookback": "120d", "source": "yfinance", "bar_method": "custom_1h_aggregation", "timezone": "America/New_York", "regular_hours_only": True},
            }}},
        }
        current_cache = {
            "cache_age_seconds": 0,
            "quote": {"history": {"intervals": {
                "1h": {"lookback": server.TECHNICAL_INTRADAY_HISTORY_PERIOD},
                "4h": {
                    "lookback": server.TECHNICAL_FOUR_HOUR_HISTORY_PERIOD,
                    "source": "yfinance",
                    "bar_method": server.TECHNICAL_FOUR_HOUR_BAR_METHOD,
                    "timezone": server.TECHNICAL_FOUR_HOUR_TIMEZONE,
                    "regular_hours_only": True,
                },
            }}},
        }

        self.assertFalse(server.is_market_cache_fresh(old_cache))
        self.assertTrue(server.is_market_cache_fresh(current_cache))

    @staticmethod
    def native_four_hour_frame(rows):
        index = pd.DatetimeIndex([entry[0] for entry in rows], tz=server.TECHNICAL_FOUR_HOUR_TIMEZONE)
        return pd.DataFrame(
            {
                "Open": [entry[1] for entry in rows],
                "High": [entry[2] for entry in rows],
                "Low": [entry[3] for entry in rows],
                "Close": [entry[4] for entry in rows],
                "Volume": [entry[5] for entry in rows],
            },
            index=index,
        )

    def test_native_four_hour_validation_preserves_normal_two_bar_session(self):
        frame = self.native_four_hour_frame([
            ("2026-08-05 09:30", 600.53, 601.00, 580.12, 583.70, 7_624_816),
            ("2026-08-05 13:30", 583.89, 590.18, 580.28, 588.91, 4_772_333),
        ])

        validation = server.validate_native_four_hour_history_frame(frame)
        payload = server.native_four_hour_history_payload(
            frame,
            metadata={"dataGranularity": "4h", "exchangeTimezoneName": "America/New_York"},
        )

        self.assertEqual(len(validation["frame"]), 2)
        self.assertEqual(validation["normal_session_days"], 1)
        self.assertEqual(validation["single_session_days"], 0)
        self.assertEqual(int(validation["frame"]["Volume"].sum()), 12_397_149)
        self.assertTrue(payload["available"])
        self.assertEqual(payload["bar_method"], "provider_native_v1")
        self.assertTrue(payload["regular_hours_only"])
        self.assertEqual(payload["timezone"], "America/New_York")

    def test_native_four_hour_sample_matches_real_one_hour_session_segments(self):
        one_hour = self.native_four_hour_frame([
            ("2026-08-05 09:30", 600.53, 601.00, 591.18, 591.81, 3_222_962),
            ("2026-08-05 10:30", 591.82, 593.06, 585.96, 585.96, 1_351_682),
            ("2026-08-05 11:30", 585.90, 587.47, 580.12, 583.04, 1_775_071),
            ("2026-08-05 12:30", 582.98, 585.50, 581.00, 583.70, 1_275_101),
            ("2026-08-05 13:30", 583.89, 584.22, 582.53, 582.89, 891_022),
            ("2026-08-05 14:30", 582.88, 588.86, 580.28, 588.42, 2_288_739),
            ("2026-08-05 15:30", 588.48, 590.18, 586.38, 588.91, 1_592_572),
        ])
        native = self.native_four_hour_frame([
            ("2026-08-05 09:30", 600.53, 601.00, 580.12, 583.70, 7_624_816),
            ("2026-08-05 13:30", 583.89, 590.18, 580.28, 588.91, 4_772_333),
        ])

        def aggregate(rows):
            return {
                "Open": float(rows["Open"].iloc[0]),
                "High": float(rows["High"].max()),
                "Low": float(rows["Low"].min()),
                "Close": float(rows["Close"].iloc[-1]),
                "Volume": int(rows["Volume"].sum()),
            }

        opening, closing = aggregate(one_hour.iloc[:4]), aggregate(one_hour.iloc[4:])
        self.assertEqual(opening, {key: (int(value) if key == "Volume" else value) for key, value in native.iloc[0].to_dict().items()})
        self.assertEqual(closing, {key: (int(value) if key == "Volume" else value) for key, value in native.iloc[1].to_dict().items()})
        self.assertEqual(int(native["Volume"].sum()), int(one_hour["Volume"].sum()))
        self.assertEqual(float(native.iloc[1]["Close"]), float(one_hour.iloc[-1]["Close"]))

    def test_native_four_hour_validation_retains_single_bar_early_close(self):
        frame = self.native_four_hour_frame([
            ("2025-11-28 09:30", 636.08, 646.25, 635.50, 645.30, 4_862_458),
        ])

        validation = server.validate_native_four_hour_history_frame(frame)

        self.assertEqual(len(validation["frame"]), 1)
        self.assertEqual(validation["normal_session_days"], 0)
        self.assertEqual(validation["single_session_days"], 1)
        self.assertEqual(float(validation["frame"].iloc[0]["Close"]), 645.30)
        self.assertEqual(int(validation["frame"].iloc[0]["Volume"]), 4_862_458)

    def test_native_four_hour_validation_rejects_afternoon_only_source_day(self):
        frame = self.native_four_hour_frame([
            ("2026-02-02 13:30", 713.01, 715.59, 706.22, 706.42, 4_070_334),
        ])

        validation = server.validate_native_four_hour_history_frame(frame)
        payload = server.native_four_hour_history_payload(frame)

        self.assertTrue(validation["frame"].empty)
        self.assertEqual(validation["invalid_session_days"], 1)
        self.assertFalse(payload["available"])
        self.assertEqual(payload["unavailable_reason"], "invalid_source_data")

    def test_native_four_hour_loader_uses_primary_provider_without_fallback(self):
        frame = self.native_four_hour_frame([
            ("2026-08-05 09:30", 600.53, 601.00, 580.12, 583.70, 7_624_816),
        ])

        class Instrument:
            history_metadata = {"dataGranularity": "4h", "exchangeTimezoneName": "America/New_York"}

            def __init__(self):
                self.calls = []

            def history(self, **kwargs):
                self.calls.append(kwargs)
                return frame

        instrument = Instrument()
        result, metadata, reason = server.load_yfinance_native_four_hour_history_frame(instrument, period="120d")

        self.assertIs(result, frame)
        self.assertEqual(reason, None)
        self.assertEqual(metadata["dataGranularity"], "4h")
        self.assertEqual(instrument.calls, [{"period": "120d", "interval": "4h", "auto_adjust": False, "prepost": False}])

    def test_native_four_hour_failure_stays_unavailable(self):
        payload = server.native_four_hour_history_payload(None, failure_reason="source_unavailable")

        self.assertFalse(payload["available"])
        self.assertEqual(payload["unavailable_reason"], "source_unavailable")
        self.assertEqual(payload["timestamps"], [])

    def test_history_payload_only_drops_required_ohlcv_nulls(self):
        frame = pd.DataFrame(
            {
                "Open": [10.0, 11.0],
                "High": [11.0, 12.0],
                "Low": [9.0, 10.0],
                "Close": [10.5, 11.5],
                "Volume": [100, 200],
                # Optional provider data must not remove otherwise valid OHLCV.
                "Adj Close": [None, None],
            },
            index=pd.date_range("2026-01-01", periods=2, freq="D"),
        )

        payload = server._history_payload(frame)

        self.assertTrue(payload["available"])
        self.assertEqual(payload["availability"], "available")
        self.assertEqual(payload["available_bars"], 2)
        self.assertEqual(payload["excluded_invalid_rows"], 0)

    def test_yahoo_frame_never_substitutes_missing_ohlcv(self):
        original = server.fetch_yahoo_chart_rows
        try:
            server.fetch_yahoo_chart_rows = lambda *args, **kwargs: [
                {"datetime": pd.Timestamp("2026-01-01T09:30:00Z"), "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5, "volume": 100},
                {"datetime": pd.Timestamp("2026-01-01T10:30:00Z"), "open": 10.5, "high": None, "low": 10.0, "close": 10.75, "volume": None},
            ]

            frame = server.fetch_yahoo_chart_frame("META", range_value="120d", interval="1h", limit=6000)

            self.assertEqual(len(frame), 1)
            self.assertEqual(float(frame.iloc[0]["Open"]), 10.0)
            self.assertEqual(int(frame.iloc[0]["Volume"]), 100)
        finally:
            server.fetch_yahoo_chart_rows = original

    def test_stooq_frame_never_substitutes_missing_ohlcv(self):
        original = server.fetch_stooq_history_rows
        try:
            server.fetch_stooq_history_rows = lambda *args, **kwargs: [
                {"datetime": pd.Timestamp("2026-01-01T00:00:00Z"), "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5, "volume": 100},
                {"datetime": pd.Timestamp("2026-01-02T00:00:00Z"), "open": None, "high": 12.0, "low": 10.0, "close": 11.5, "volume": None},
            ]

            frame = server.fetch_stooq_chart_frame("META", limit=260)

            self.assertEqual(len(frame), 1)
            self.assertEqual(float(frame.iloc[0]["Close"]), 10.5)
        finally:
            server.fetch_stooq_history_rows = original


class CompanyProfilePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="company-profile-store-")
        self.db_path = str(Path(self.temp.name) / "watchlist.db")
        self.path_patch = patch.object(server, "WATCHLIST_DB_PATH", self.db_path)
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.temp.cleanup()

    @staticmethod
    def stock_quote(metadata=None):
        return {"metadata": {"quoteType": "EQUITY", **(metadata or {})}}

    @staticmethod
    def complete_profile(primary="Semiconductors", business="MegaCap", risk="HighVolatility", lifecycle="Scaling"):
        return {
            "primaryClassification": primary, "businessTrait": business,
            "riskTrait": risk, "lifecycle": lifecycle,
            "companyTraits": [business, risk], "profileStatus": "complete",
            "profileSource": "automatic", "profileEvidence": {"primaryClassification": ["industry:test"]},
        }

    def test_profile_store_persists_and_complete_profile_does_not_churn_hourly(self):
        quotes = {"NEW": self.stock_quote({"industry": "Semiconductors", "marketCap": 300_000_000_000})}
        with patch.object(server, "_classify_company_profiles", return_value={"NEW": self.complete_profile()} ) as classify:
            first = server.ensure_company_profiles_for_quotes(quotes, now=datetime(2026, 9, 10, 12, tzinfo=ZoneInfo("America/New_York")))
            self.assertEqual(first["NEW"]["primaryClassification"], "Semiconductors")
            self.assertEqual(first["NEW"]["companyTraits"], ["MegaCap", "HighVolatility"])
            self.assertEqual(first["NEW"]["profileConfidence"], 0.82)
            # Simulate an in-memory restart by reading the SQLite source anew.
            persisted = server.load_company_profiles(["NEW"])
            self.assertEqual(persisted["NEW"]["lifecycle"], "Scaling")
            changed_metadata = {"NEW": self.stock_quote({"industry": "Banking", "marketCap": 1})}
            second = server.ensure_company_profiles_for_quotes(changed_metadata, now=datetime(2026, 9, 11, 12, tzinfo=ZoneInfo("America/New_York")))
            self.assertEqual(second["NEW"]["primaryClassification"], "Semiconductors")
            self.assertEqual(classify.call_count, 1, "a complete profile is not reclassified by normal hourly refresh")

    def test_incomplete_profile_fills_null_without_overwriting_existing_field(self):
        existing = {
            "primaryClassification": "Enterprise Software", "businessTrait": None,
            "riskTrait": None, "lifecycle": None, "profileEvidence": {"primaryClassification": ["industry:software"]},
            "profileConfidence": 0.82, "lastProfileReview": "2026-09-10T12:00:00-04:00",
        }
        classified = self.complete_profile(primary="Banking", business="HighGrowth", risk="HighVolatility", lifecycle="Scaling")
        merged = server._merged_profile(existing, classified, "2026-09-11T12:00:00-04:00", allow_replace=False)
        self.assertEqual(merged["primaryClassification"], "Enterprise Software")
        self.assertEqual(merged["businessTrait"], "HighGrowth")
        self.assertEqual(merged["riskTrait"], "HighVolatility")
        self.assertEqual(merged["lifecycle"], "Scaling")
        self.assertEqual(merged["profileConfidence"], 0.82)

    def test_incomplete_hourly_reclassification_without_new_evidence_does_not_rewrite_store(self):
        quotes = {"PART": self.stock_quote({"industry": "Software - Application"})}
        incomplete = {
            "primaryClassification": "Enterprise Software", "businessTrait": None,
            "riskTrait": None, "lifecycle": None, "companyTraits": [],
            "profileStatus": "incomplete", "profileSource": "automatic",
            "profileEvidence": {"primaryClassification": ["industry:software"]},
        }
        with patch.object(server, "_classify_company_profiles", return_value={"PART": incomplete}):
            server.ensure_company_profiles_for_quotes(
                quotes, now=datetime(2026, 9, 10, 12, tzinfo=ZoneInfo("America/New_York")),
            )
            first = server.load_company_profiles(["PART"])["PART"]
            server.ensure_company_profiles_for_quotes(
                quotes, now=datetime(2026, 9, 10, 13, tzinfo=ZoneInfo("America/New_York")),
            )
            second = server.load_company_profiles(["PART"])["PART"]
        self.assertEqual(first["lastProfileReview"], second["lastProfileReview"])

    def test_annual_review_is_march_31_et_and_insufficient_evidence_keeps_valid_profile(self):
        last_review = "2026-09-10T12:00:00-04:00"
        before = datetime(2027, 3, 30, 12, tzinfo=ZoneInfo("America/New_York"))
        on_date = datetime(2027, 3, 31, 12, tzinfo=ZoneInfo("America/New_York"))
        self.assertFalse(server._profile_review_due(last_review, before))
        self.assertTrue(server._profile_review_due(last_review, on_date))
        self.assertEqual(server.next_company_profile_review(datetime(2026, 9, 10, 12, tzinfo=ZoneInfo("America/New_York"))).date().isoformat(), "2027-03-31")
        self.assertEqual(server.next_company_profile_review(datetime(2027, 4, 10, 12, tzinfo=ZoneInfo("America/New_York"))).date().isoformat(), "2028-03-31")
        original = self.complete_profile()
        sparse = {"profileEvidence": {}}
        merged = server._merged_profile(original, sparse, "2027-03-31T12:00:00-04:00", allow_replace=True)
        self.assertEqual(merged["primaryClassification"], "Semiconductors")
        self.assertEqual(merged["businessTrait"], "MegaCap")
        self.assertEqual(merged["riskTrait"], "HighVolatility")
        self.assertEqual(merged["lifecycle"], "Scaling")

    def test_etf_skips_stock_classifier_and_annual_review_uses_force_path(self):
        etf = {"QQQ": {"metadata": {"quoteType": "ETF", "industry": "Exchange Traded Fund"}}}
        with patch.object(server, "_classify_company_profiles") as classify:
            self.assertEqual(server.ensure_company_profiles_for_quotes(etf), {})
            classify.assert_not_called()
        payload = {"quotes": {"NEW": self.stock_quote({"industry": "Semiconductors"})}}
        summary = {"completed": True}
        with patch.object(server, "_refresh_market_cache_for_watchlist", return_value=summary), patch.object(server, "load_shared_watchlist", return_value=["NEW"]), patch.object(server, "build_market_data_payload", return_value=payload), patch.object(server, "ensure_company_profiles_for_quotes") as ensure:
            outcome = server.run_company_profile_annual_review_once(datetime(2027, 3, 31, 12, tzinfo=ZoneInfo("America/New_York")), reason="test")
        self.assertEqual(outcome["status"], "success")
        ensure.assert_called_once_with(payload["quotes"], force_review=True, now=datetime(2027, 3, 31, 12, tzinfo=ZoneInfo("America/New_York")))


if __name__ == "__main__":
    unittest.main()
