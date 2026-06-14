/**
 * OpenTelemetry wiring — env-driven, surface-level, and safe with no collector.
 *
 * Tracing/metrics are enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
 * (the standard OTel SDK env var). With it unset — as in the in-process e2e and
 * local runs without a Collector — `buildOtelInterceptor` returns `undefined`
 * and `initObservability` is a no-op, so nothing tries to export spans to a
 * missing endpoint.
 *
 * In Kubernetes the ConfigMap sets `OTEL_EXPORTER_OTLP_ENDPOINT` (and
 * `OTEL_SERVICE_NAME`, `OTEL_*_EXPORTER`) to the in-cluster Collector, turning
 * this on per role. The Istio sidecar adds mesh-level telemetry on top; this
 * interceptor adds RPC-level spans/metrics, including a `connectum.transport`
 * attribute distinguishing in-process `ctx.call`s from network hops.
 *
 * @module observability
 */

import type { Interceptor } from "@connectrpc/connect";
import { createOtelInterceptor, initProvider, shutdownProvider } from "@connectum/otel";

/** True when an OTLP endpoint is configured (telemetry should be enabled). */
export function otelEnabled(): boolean {
    return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/** Service identity reported to OTel; defaults per role via OTEL_SERVICE_NAME. */
export function otelServiceName(): string {
    return process.env.OTEL_SERVICE_NAME ?? "car-sharing";
}

/**
 * Initialize the OTel provider when an endpoint is configured. No-op otherwise.
 * Must run before the server starts so exporters are registered.
 */
export function initObservability(): void {
    if (!otelEnabled()) return;
    initProvider({ serviceName: otelServiceName() });
}

/**
 * Build the server OTel interceptor when telemetry is enabled, else `undefined`
 * (so the caller can omit it from the chain).
 *
 * `trustRemote: true` adopts the incoming W3C trace context so spans from the
 * gateway, fleet and billing stitch into one distributed trace across pods.
 */
export function buildOtelInterceptor(): Interceptor | undefined {
    if (!otelEnabled()) return undefined;
    return createOtelInterceptor({ trustRemote: true });
}

/** Flush and shut down the OTel provider on stop. No-op when disabled. */
export async function shutdownObservability(): Promise<void> {
    if (!otelEnabled()) return;
    await shutdownProvider();
}
