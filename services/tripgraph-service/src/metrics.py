"""
Breeze TripGraph Service — OpenTelemetry metrics wrapper.
All routing metrics in one place. Initialized before first request.
"""

from __future__ import annotations

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.resources import Resource


class RoutingMetrics:
    """Wraps all OpenTelemetry metrics for the routing engine."""

    def __init__(self) -> None:
        resource = Resource.create({"service.name": "tripgraph-service"})
        provider = MeterProvider(resource=resource)
        metrics.set_meter_provider(provider)
        meter = metrics.get_meter("tripgraph-service", "0.1.0")

        # ── Counters ─────────────────────────────────────────
        self.route_search_total = meter.create_counter(
            "route_search_total",
            description="Total route searches",
        )
        self.location_fallback_total = meter.create_counter(
            "location_resolution_fallback_total",
            description="Location resolutions requiring fallback",
        )

        # ── Histograms ───────────────────────────────────────
        self.route_search_duration = meter.create_histogram(
            "route_search_duration_seconds",
            description="Route search latency",
            unit="s",
        )
        self.routes_found_count = meter.create_histogram(
            "routes_found_count",
            description="Number of routes returned per search",
        )
        self.csa_connections_scanned = meter.create_histogram(
            "csa_connections_scanned",
            description="Connections scanned by CSA per search",
        )

        # ── Gauges ───────────────────────────────────────────
        self.graph_store_node_count = meter.create_up_down_counter(
            "graph_store_node_count",
            description="Number of nodes in GraphStore",
        )
        self.cache_hit_ratio = meter.create_up_down_counter(
            "cache_hit_ratio",
            description="Route cache hit ratio",
        )


# Module-level singleton — initialized once at import time
routing_metrics = RoutingMetrics()
