const SOCKET2_DEVICE_ID = 'bfcbd371e1af7827f9sj79';
const ECOFLOW_DEVICE_ID = 'ecoflow';
const GRID_VOLTAGE_THRESHOLD = 50;

/**
 * Legacy function - kept for backward compatibility, delegates to new logic
 * @param {boolean|undefined|null} isOnline
 * @param {number|null|undefined} voltageV
 * @returns {boolean|null} true=grid present, false=absent, null=unknown
 */
function computeGridPresent(isOnline, voltageV) {
    if (!isOnline) {
        return false;
    }
    if (voltageV === null || voltageV === undefined || Number.isNaN(Number(voltageV))) {
        return null;
    }
    return Number(voltageV) >= GRID_VOLTAGE_THRESHOLD;
}

/**
 * Determines grid power status using two input sockets and a witness device.
 * 
 * Logic:
 * - If at least one socket is online -> PRESENT (single socket drop = Wi-Fi issue, power is on)
 * - If both sockets offline AND witness online -> ABSENT (real outage, witness proves internet works)
 * - If both sockets offline AND witness offline -> UNKNOWN (internet down, can't determine power state)
 * 
 * @param {object|undefined} socket1Result - First input socket device result (with isOnline, voltageV)
 * @param {object|undefined} socket2Result - Second input socket device result (with isOnline, voltageV)
 * @param {object|undefined} witnessResult - Witness device result (with isOnline) - should be on backup power
 * @returns {'present'|'absent'|'unknown'} - Grid power status
 */
function determineGridState(socket1Result, socket2Result, witnessResult) {
    const socket1Online = socket1Result && socket1Result.isOnline === true;
    const socket2Online = socket2Result && socket2Result.isOnline === true;
    
    // At least one socket online -> power PRESENT (even if the other socket's Wi-Fi dropped)
    if (socket1Online || socket2Online) {
        // Check voltage on online sockets for additional validation
        const onlineSocket = socket1Online ? socket1Result : socket2Result;
        if (onlineSocket.voltageV !== null && onlineSocket.voltageV !== undefined && !Number.isNaN(Number(onlineSocket.voltageV))) {
            // If we have voltage data, use it for validation
            return Number(onlineSocket.voltageV) >= GRID_VOLTAGE_THRESHOLD ? 'present' : 'absent';
        }
        // No voltage data but socket is online -> assume present
        return 'present';
    }
    
    // Both sockets EXPLICITLY offline (isOnline=false)
    const socket1Offline = socket1Result && socket1Result.isOnline === false;
    const socket2Offline = socket2Result && socket2Result.isOnline === false;
    
    if (socket1Offline && socket2Offline) {
        // Check witness: if online, internet works and power is truly absent
        const witnessOnline = witnessResult && witnessResult.isOnline === true;
        if (witnessOnline) {
            return 'absent';
        }
        // Witness offline too -> internet down, can't determine power state
        return 'unknown';
    }
    
    // Undefined/null/errors -> unknown
    return 'unknown';
}

module.exports = {
    SOCKET2_DEVICE_ID,
    ECOFLOW_DEVICE_ID,
    GRID_VOLTAGE_THRESHOLD,
    computeGridPresent,
    determineGridState,
};
