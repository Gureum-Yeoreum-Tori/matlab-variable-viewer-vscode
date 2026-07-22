// Copyright 2023-2026 The MathWorks, Inc.
// Modifications copyright 2026 MATLAB Variable Viewer fork contributors.

import BaseService from '../BaseService'

export interface TelemetryEvent {
    eventKey: string
    data: unknown
}

/**
 * Compatibility telemetry sink for the unofficial fork.
 *
 * Upstream services still emit telemetry events internally, but a fork must not
 * submit them using MathWorks' application identity or collection key. Keeping
 * this no-op service avoids invasive changes throughout the extension while
 * guaranteeing that no event leaves the local extension host.
 */
export default class TelemetryLogger extends BaseService {
    constructor (_extensionVersion: string) {
        super()
    }

    logEvent (_event: TelemetryEvent): void {
        // Intentionally disabled for this unofficial fork.
    }
}
