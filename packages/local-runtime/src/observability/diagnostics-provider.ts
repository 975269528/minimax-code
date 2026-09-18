export interface LocalHostDiagnosticsProvider {
  uploadDiagnosticBundle?(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export function hostDiagnosticsUnavailable(capability: string): Record<string, unknown> {
  return {
    available: false,
    error: 'host_diagnostics_unavailable',
    capability,
    reason: 'No host diagnostics provider is registered for this local runtime owner.',
  };
}
