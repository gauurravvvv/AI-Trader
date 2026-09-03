"""Broker infrastructure: provider-specific brokerage API adapters.

Currently houses the Alpaca paper-trading adapter. This layer owns provider
HTTP calls, credential handling, and response/error normalization. Orchestration
(routes, caching, session tracking, baseline aggregation) lives elsewhere.
"""
