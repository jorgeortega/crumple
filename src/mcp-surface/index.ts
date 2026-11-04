export { convertOpenApi } from './convert.js';
export type { Conversion, ConvertOptions, SurfaceTool, ToolAnnotations } from './convert.js';
export { createMcpSurface } from './server.js';
export type { AccessOptions, McpSurface, McpSurfaceOptions } from './server.js';

// The map lets cli import only this module and fault-api, so what it needs comes through here.
export { callerId, createKey, memoryKeyStore, plainCredential, sealCredential, sealedCredential } from '../access-control/index.js';
export type { Credential, Grant, JwtConfig, KeyRecord, KeyStore, Sealed } from '../access-control/index.js';
export { createAudit, createTelemetry, formatTrace, memoryAuditSink, memorySink, metricsSink, otlpSink } from '../telemetry/index.js';
export type { Audit, AuditEvent, AuditSink, MemoryAuditSink, MemorySink, MetricsSink, OtlpSink, SpanSink, Telemetry } from '../telemetry/index.js';
